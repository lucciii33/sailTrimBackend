const Doc = require("../model/DocModel");
const ApiWatcher = require("../model/ApiWatcherModel");
const WatcherRun = require("../model/WatcherRunModel");
const BackfillJob = require("../model/BackfillJob");
const apiSuiteService = require("./apiSuiteService");
const { getUserAnthropicClient } = require("./userKeyService");

// The watcher agent.
//
// Something lands on the watched branch -> regenerate the repo's docs -> work
// out which endpoints are NEW -> flag them and generate QA for them. The point
// is that an endpoint shipped on Friday is documented and covered by Monday
// without anyone remembering to press a button.
//
// Doc regeneration reuses runBackfill, the exact pipeline the manual button
// drives. Required lazily because githubController requires this file's
// siblings — importing it at module load closes a cycle.
function backfillRunner() {
  return require("../controllers/githubController").runBackfill;
}

// Identity of an endpoint across regenerations. A doc's _id changes if it is
// deleted and recreated, so "new" is decided on method+path, which is what a
// human means by "a new endpoint appeared".
function endpointKey(doc) {
  return `${String(doc.method || "").toUpperCase()} ${doc.path}`;
}

/**
 * Compare the repo's endpoints against a snapshot and flag whatever is new.
 *
 * Split out of runWatcher so the comparison can be exercised on its own: the
 * snapshot is taken before regeneration and the diff after, which makes the
 * whole thing awkward to test as one block.
 */
async function diffAndFlagNewEndpoints({ scope, beforeKeys, prNumber = null }) {
  const after = await Doc.find(scope).select("method path").lean();
  const fresh = after.filter((d) => !beforeKeys.has(endpointKey(d)));

  if (fresh.length) {
    await Doc.updateMany(
      { _id: { $in: fresh.map((d) => d._id) } },
      {
        $set: {
          isNewEndpoint: true,
          firstSeenAt: new Date(),
          firstSeenPr: prNumber,
        },
      }
    );
  }
  return { after, fresh };
}

/**
 * Run one watcher end to end.
 *
 * Never throws: a watcher fires from a webhook, where nothing is listening for
 * an exception and a crash would leave the run row stuck at "running". Failures
 * are recorded on the run instead.
 */
async function runWatcher({ watcherId, trigger = { kind: "manual" } }) {
  const watcher = await ApiWatcher.findById(watcherId);
  if (!watcher) return null;

  const run = await WatcherRun.create({
    watcherId: watcher._id,
    owner: watcher.owner,
    repo: watcher.repo,
    trigger: { ...trigger, branch: trigger.branch || watcher.branch },
    status: "running",
    userId: watcher.userId,
    companyId: watcher.companyId,
  });

  watcher.lastRun = {
    at: new Date(),
    status: "running",
    newEndpoints: 0,
    testsCreated: 0,
  };
  await watcher.save();

  try {
    const scope = {
      owner: watcher.owner,
      repo: watcher.repo,
      companyId: watcher.companyId,
    };

    // 1) Snapshot what exists BEFORE regenerating. Taken as a set of
    // method+path so a doc that is rewritten in place doesn't read as new.
    const before = await Doc.find(scope).select("method path").lean();
    const beforeKeys = new Set(before.map(endpointKey));

    // 2) Regenerate the docs through the same job the manual button uses, so
    // the two can't drift.
    if (watcher.actions?.regenerateDocs !== false) {
      const job = await BackfillJob.create({
        installationId: watcher.installationId,
        owner: watcher.owner,
        repo: watcher.repo,
        userId: watcher.userId,
        status: "pending",
      });
      await backfillRunner()(job._id);

      const finished = await BackfillJob.findById(job._id).lean();
      if (finished?.status === "failed") {
        throw new Error(
          `Doc regeneration failed: ${finished.error || "unknown error"}`
        );
      }
    }

    // 3) Diff. Anything present now that wasn't in the snapshot is new.
    const { after, fresh } = await diffAndFlagNewEndpoints({
      scope,
      beforeKeys,
      prNumber: trigger.prNumber || null,
    });

    // 4) Generate QA for the new endpoints only. One at a time, and a failure
    // on one endpoint is recorded rather than allowed to sink the run — the
    // other endpoints are still flagged and still worth reporting.
    const anthropicClient = watcher.userId
      ? await getUserAnthropicClient(watcher.userId).catch(() => null)
      : null;

    let testsCreated = 0;
    let testsPassed = 0;
    let testsFailed = 0;
    const rows = [];
    for (const d of fresh) {
      const row = {
        docId: d._id,
        method: d.method,
        path: d.path,
        testsCreated: 0,
        testError: "",
      };
      if (watcher.actions?.generateTests !== false) {
        const suites = [];
        try {
          for (const kind of ["smoke", "regression"]) {
            const suite = await apiSuiteService.generateSuite({
              docId: d._id,
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
          console.error(
            `[watcher] tests failed for ${d.method} ${d.path}:`,
            err.message
          );
          row.testError = err.message;
        }

        // Execute what was just generated, so the morning after a merge you
        // know whether the new endpoint WORKS, not only that it exists.
        // Reported separately from generation: a project with no baseUrl or
        // auth can't run anything, and that must not look like the tests
        // failed to be written.
        if (watcher.actions?.runTests === true && suites.length) {
          for (const suite of suites) {
            try {
              const res = await apiSuiteService.runSuite({
                suiteId: suite._id,
                companyId: watcher.companyId,
                anthropicClient,
              });
              row.testsPassed += res.summary.passed;
              row.testsFailed += res.summary.failed;
              testsPassed += res.summary.passed;
              testsFailed += res.summary.failed;
            } catch (err) {
              console.error(
                `[watcher] run failed for ${d.method} ${d.path}:`,
                err.message
              );
              row.runError = err.message;
            }
          }
        }
      }
      rows.push(row);
    }

    run.newEndpoints = rows;
    run.docsBefore = before.length;
    run.docsAfter = after.length;
    run.status = "success";
    run.finishedAt = new Date();
    await run.save();

    watcher.lastRun = {
      at: new Date(),
      status: "success",
      newEndpoints: fresh.length,
      testsCreated,
      testsPassed,
      testsFailed,
    };
    await watcher.save();

    console.log(
      `[watcher] ${watcher.owner}/${watcher.repo}: ${fresh.length} new endpoint(s), ${testsCreated} test(s)` +
        (watcher.actions?.runTests ? `, ${testsPassed} passed / ${testsFailed} failed` : "")
    );
    return run;
  } catch (err) {
    console.error(`[watcher] run failed for ${watcher.owner}/${watcher.repo}:`, err);
    run.status = "failed";
    run.error = err.message || String(err);
    run.finishedAt = new Date();
    await run.save().catch(() => {});
    watcher.lastRun = {
      at: new Date(),
      status: "failed",
      newEndpoints: 0,
      testsCreated: 0,
    };
    await watcher.save().catch(() => {});
    return run;
  }
}

/**
 * Fire every watcher that cares about a merge. Called from the webhook, which
 * must answer GitHub immediately — a full regeneration takes minutes, so the
 * runs are started and deliberately NOT awaited.
 */
async function onBranchUpdated({ owner, repo, branch, trigger }) {
  const watchers = await ApiWatcher.find({ owner, repo, branch, enabled: true });
  if (!watchers.length) return 0;

  // Re-check the plan at FIRING time, not just at creation. A workspace that
  // downgrades keeps its watcher rows, and without this they would quietly go
  // on consuming model calls for a plan the company no longer pays for.
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
  if (!allowed.length) return 0;

  for (const w of allowed) {
    runWatcher({ watcherId: w._id, trigger }).catch((err) =>
      console.error("[watcher] background run failed:", err.message)
    );
  }
  return allowed.length;
}

module.exports = {
  runWatcher,
  onBranchUpdated,
  endpointKey,
  diffAndFlagNewEndpoints,
};
