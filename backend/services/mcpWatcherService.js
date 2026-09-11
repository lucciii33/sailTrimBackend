const McpProject = require("../model/McpProjectModel.js");
const McpTool = require("../model/McpToolModel.js");
const McpDoc = require("../model/McpDocModel.js");
const McpWatcher = require("../model/McpWatcherModel.js");
const McpWatcherRun = require("../model/McpWatcherRunModel.js");
const mcpProjects = require("./mcpProjectService.js");
const mcpLab = require("./mcpLabService.js");
const mcpQa = require("./mcpQaService.js");
const mcpToolSuites = require("./mcpToolSuiteService.js");
const { getUserAnthropicClient } = require("./userKeyService.js");

// The MCP watcher agent — the counterpart of watcherService for APIs.
//
// Same trigger (a merge into the watched branch), same outcome (new things are
// flagged, tested, and bug-hunted), different source of truth. The API watcher
// reads the merged CODE from GitHub, which is up to date the moment the merge
// lands. MCP tools come from the LIVE server, and at the moment of the merge
// that server is still running the previous build. So instead of looking once,
// this re-asks the server on an interval until the new tools appear or the
// wait runs out.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toolNamesOf(tools) {
  return (tools || []).map((t) => t?.name).filter(Boolean);
}

/**
 * Compare a live tool list against the pre-merge baseline, refresh the stored
 * tools, and flag the ones that are new.
 *
 * Split out so it can be exercised without a reachable server: the live list is
 * a parameter, normally supplied by mcpLab.listTools().
 */
async function diffAndFlagNewTools({
  project,
  beforeNames,
  liveTools,
  prNumber = null,
  userId,
  companyId,
}) {
  const before = new Set(beforeNames || []);
  const fresh = (liveTools || []).filter((t) => t?.name && !before.has(t.name));

  // Mirror the live server into McpTool — including removing tools it no longer
  // exposes — so docs, suites and QA all see the real current set.
  await mcpProjects.upsertProjectTools({
    project,
    tools: liveTools,
    userId,
    companyId,
  });

  if (fresh.length) {
    await McpTool.updateMany(
      { projectId: project._id, name: { $in: fresh.map((t) => t.name) } },
      {
        $set: {
          isNewTool: true,
          firstSeenAt: new Date(),
          firstSeenPr: prNumber,
        },
      }
    );
  }
  return { fresh, liveCount: (liveTools || []).length };
}

/**
 * Real argument values for a brand-new tool, borrowed from its siblings.
 *
 * A tool the watcher just discovered has no verified sample args yet, so its QA
 * would invent every id and report "not found" as a bug. Sibling tools on the
 * same server usually take the same ids (get_product and a new
 * get_product_orders both take product_id), and their docs carry values that
 * were verified against the live server. Reuse those, matched by argument name.
 */
async function harvestKnownArgs({ projectId, companyId, tool }) {
  const wanted = Object.keys(tool?.inputSchema?.properties || {});
  if (!wanted.length) return {};

  const [docs, tools] = await Promise.all([
    McpDoc.find({ projectId, companyId }).select("toolName sampleArgs responseVerified").lean(),
    McpTool.find({ projectId, companyId }).select("name suggestedArgs").lean(),
  ]);

  // Verified doc args first — they were confirmed against the live server.
  const sources = [
    ...docs.filter((d) => d.responseVerified).map((d) => d.sampleArgs),
    ...docs.filter((d) => !d.responseVerified).map((d) => d.sampleArgs),
    ...tools.map((t) => t.suggestedArgs),
  ];
  const known = {};
  for (const args of sources) {
    if (!args || typeof args !== "object") continue;
    for (const name of wanted) {
      const v = args[name];
      if (known[name] === undefined && v !== undefined && v !== null && v !== "") {
        known[name] = v;
      }
    }
  }
  return known;
}

async function runPendingRun(runId) {
  // Atomic claim — a GitHub retry or a second instance draining the backlog
  // must not start the same wait-and-test twice.
  const run = await McpWatcherRun.findOneAndUpdate(
    { _id: runId, status: { $in: ["pending", "running"] } },
    { $set: { status: "running", startedAt: new Date() }, $inc: { attempts: 1 } },
    { new: true }
  );
  if (!run) return null;

  const watcher = await McpWatcher.findById(run.watcherId);
  const fail = async (message) => {
    run.status = "failed";
    run.error = message;
    run.finishedAt = new Date();
    await run.save().catch(() => {});
    if (watcher) {
      watcher.lastRun = { at: new Date(), status: "failed", newTools: 0, testsCreated: 0, bugsFound: 0 };
      await watcher.save().catch(() => {});
    }
    return run;
  };

  if (!watcher) return fail("The watcher was deleted before this run started.");

  const project = await McpProject.findOne({
    _id: watcher.mcpProjectId,
    companyId: watcher.companyId,
  });
  if (!project) return fail("The MCP project this watcher points at no longer exists.");

  watcher.lastRun = { at: new Date(), status: "running", newTools: 0, testsCreated: 0, bugsFound: 0 };
  await watcher.save();

  try {
    const { config } = await mcpProjects.resolveConfig({
      projectId: project._id,
      companyId: watcher.companyId,
    });
    const shownUrl = mcpProjects.publicServerUrl
      ? mcpProjects.publicServerUrl(config?.url)
      : "the MCP server";

    // Wait for the deploy. First check is immediate — the deploy may already
    // be done by the time the run is picked up (always true on a resume).
    const intervalMs = Math.max(5, watcher.wait?.intervalSec ?? 60) * 1000;
    const maxChecks = Math.max(
      1,
      Math.ceil(((watcher.wait?.maxMinutes ?? 15) * 60 * 1000) / intervalMs)
    );

    let liveTools = null;
    let reached = false;
    let lastError = "";
    let fresh = [];
    const before = new Set(run.toolsBeforeNames || []);

    for (let i = 0; i < maxChecks; i++) {
      run.checks = i + 1;
      try {
        liveTools = await mcpLab.listTools(config);
        reached = true;
        if (toolNamesOf(liveTools).some((n) => !before.has(n))) break;
      } catch (err) {
        lastError = err.message || String(err);
      }
      await run.save().catch(() => {});
      if (i < maxChecks - 1) await sleep(intervalMs);
    }

    if (!reached) {
      // The most common cause is a server on localhost — reachable from a
      // laptop, never from a deployed backend. Say that, not just "error".
      return fail(
        `Couldn't reach ${shownUrl} after ${run.checks} attempt(s): ${lastError}. ` +
          `If this server runs on localhost it isn't reachable from a deployed backend — ` +
          `the MCP project needs a URL the backend can call.`
      );
    }

    const diff = await diffAndFlagNewTools({
      project,
      beforeNames: run.toolsBeforeNames,
      liveTools,
      prNumber: run.trigger?.prNumber || null,
      userId: watcher.userId,
      companyId: watcher.companyId,
    });
    fresh = diff.fresh;
    run.toolsAfter = diff.liveCount;

    if (!fresh.length) {
      run.note =
        `No new tools appeared on the server within ${watcher.wait?.maxMinutes ?? 15} min. ` +
        `The deploy may not have finished, may not auto-deploy on merge, or this merge didn't add a tool.`;
    }

    const anthropicClient = watcher.userId
      ? await getUserAnthropicClient(watcher.userId).catch(() => null)
      : null;

    let testsCreated = 0;
    let bugsFound = 0;
    const rows = [];
    for (const tool of fresh) {
      const row = {
        name: tool.name,
        testsCreated: 0,
        testsPassed: 0,
        testsFailed: 0,
        testError: "",
        bugsFound: 0,
        qaRunId: "",
        qaError: "",
      };

      if (watcher.actions?.generateTests !== false) {
        const suites = [];
        try {
          for (const kind of ["smoke", "regression"]) {
            const suite = await mcpToolSuites.generateSuite({
              projectId: project._id,
              toolName: tool.name,
              kind,
              userId: watcher.userId,
              companyId: watcher.companyId,
              anthropicClient,
            });
            suites.push(suite);
            row.testsCreated += suite.cases.length;
          }
          testsCreated += row.testsCreated;
        } catch (err) {
          row.testError = err.message;
        }

        if (watcher.actions?.runTests === true) {
          for (const suite of suites) {
            try {
              const res = await mcpToolSuites.runSuite({
                suiteId: suite._id,
                companyId: watcher.companyId,
                anthropicClient,
              });
              row.testsPassed += res.summary.passed;
              row.testsFailed += res.summary.failed;
            } catch (err) {
              row.testError = row.testError || err.message;
            }
          }
        }
      }

      // The bug hunter — separate from the saved suites, same as on the API side.
      if (watcher.actions?.runQa !== false) {
        try {
          // Without this a new tool's happy path always runs on invented ids.
          const knownArgs = await harvestKnownArgs({
            projectId: project._id,
            companyId: watcher.companyId,
            tool,
          });
          const qa = await mcpQa.runQa({
            config,
            projectId: project._id,
            toolName: tool.name,
            sampleArgsByTool: { [tool.name]: knownArgs },
            maxCasesPerTool: 3,
            save: true,
            userId: watcher.userId,
            companyId: watcher.companyId,
            anthropicClient,
          });
          row.bugsFound = (qa.bugs || []).length;
          row.qaRunId = String(qa.runId || "");
          bugsFound += row.bugsFound;
        } catch (err) {
          row.qaError = err.message;
        }
      }
      rows.push(row);
    }

    run.newTools = rows;
    run.status = "success";
    run.finishedAt = new Date();
    await run.save();

    watcher.lastRun = {
      at: new Date(),
      status: "success",
      newTools: fresh.length,
      testsCreated,
      bugsFound,
    };
    await watcher.save();

    console.log(
      `[mcp-watcher] ${project.projectName} (${watcher.owner}/${watcher.repo}): ` +
        `${fresh.length} new tool(s) after ${run.checks} check(s), ${testsCreated} test(s), ${bugsFound} bug(s)`
    );
    return run;
  } catch (err) {
    console.error("[mcp-watcher] run failed:", err);
    return fail(err.message || String(err));
  }
}

/**
 * Record a trigger as a pending run and start it. The row — including the
 * pre-merge tool baseline — is committed before any waiting begins, so a
 * restart during the (possibly long) wait for the deploy loses nothing.
 */
async function enqueueRun({ watcher, trigger }) {
  const project = await McpProject.findById(watcher.mcpProjectId).select("projectName").lean();
  const baseline = await McpTool.find({ projectId: watcher.mcpProjectId })
    .select("name")
    .lean();

  const run = await McpWatcherRun.create({
    watcherId: watcher._id,
    mcpProjectId: watcher.mcpProjectId,
    projectName: project?.projectName || "",
    owner: watcher.owner,
    repo: watcher.repo,
    trigger: { ...trigger, branch: trigger.branch || watcher.branch },
    status: "pending",
    toolsBeforeNames: baseline.map((t) => t.name),
    userId: watcher.userId,
    companyId: watcher.companyId,
  });

  runPendingRun(run._id).catch((err) =>
    console.error("[mcp-watcher] run failed:", err.message)
  );
  return run;
}

/** Resume runs a previous process recorded but never finished. Called at boot. */
async function drainPendingRuns() {
  const orphans = await McpWatcherRun.find({
    status: { $in: ["pending", "running"] },
    attempts: { $lt: 3 },
  })
    .sort({ createdAt: 1 })
    .limit(20);

  if (orphans.length) {
    console.log(`[mcp-watcher] resuming ${orphans.length} interrupted run(s)`);
  }
  // Started without awaiting each other — every run may wait minutes for its
  // own deploy, and serialising them would make the last one wait for all.
  for (const run of orphans) {
    runPendingRun(run._id).catch((err) =>
      console.error("[mcp-watcher] resume failed:", err.message)
    );
  }
  return orphans.length;
}

/** Fire every MCP watcher that cares about this merge. */
async function onBranchUpdated({ owner, repo, branch, trigger }) {
  const watchers = await McpWatcher.find({ owner, repo, branch, enabled: true });
  if (!watchers.length) return 0;

  // Plan checked at firing time too — a downgraded workspace keeps its rows.
  const Company = require("../model/companyModel");
  const paid = new Set(
    (
      await Company.find({
        _id: { $in: watchers.map((w) => w.companyId) },
        plan: "pro",
      }).select("_id").lean()
    ).map((c) => String(c._id))
  );
  const allowed = watchers.filter((w) => paid.has(String(w.companyId)));

  for (const w of allowed) {
    await enqueueRun({ watcher: w, trigger });
  }
  return allowed.length;
}

module.exports = {
  onBranchUpdated,
  enqueueRun,
  runPendingRun,
  drainPendingRuns,
  diffAndFlagNewTools,
  harvestKnownArgs,
};
