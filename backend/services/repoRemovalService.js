const { getOctokit, getApp } = require("./githubService");

// Everything Olivia stores for one connected repo, and for an MCP project.
//
// Deleting is scoped by company everywhere it can be, so removing a repo can
// never touch another workspace that happens to have connected the same one.

// --- Repo ---------------------------------------------------------------------

async function deleteRepoData({ owner, repo, companyId, installationId }) {
  const scope = { owner, repo, companyId };
  const del = async (modelPath, filter) => {
    const Model = require(modelPath);
    const r = await Model.deleteMany(filter);
    return r.deletedCount || 0;
  };

  return {
    docs: await del("../model/DocModel", scope),
    tests: await del("../model/ApiSuiteModel", scope),
    bugs: await del("../model/BugModel", scope),
    qaRuns: await del("../model/TestRunModel", scope),
    qaConfig: await del("../model/ApiQaConfig", scope),
    watchers: await del("../model/ApiWatcherModel", scope),
    watcherRuns: await del("../model/WatcherRunModel", scope),
    mcpWatchers: await del("../model/McpWatcherModel", scope),
    mcpWatcherRuns: await del("../model/McpWatcherRunModel", scope),
    // Backfill jobs carry no companyId; the installation pins them to this
    // connection instead.
    backfillJobs: await del("../model/BackfillJob", { owner, repo, installationId }),
  };
}

// MCP projects linked to a repo. MCP projects point at a server, not a repo,
// so the only link is an MCP watcher that ties the two together.
async function linkedMcpProjectIds({ owner, repo, companyId }) {
  const McpWatcher = require("../model/McpWatcherModel");
  const watchers = await McpWatcher.find({ owner, repo, companyId })
    .select("mcpProjectId")
    .lean();
  return [...new Set(watchers.map((w) => String(w.mcpProjectId)))];
}

// --- MCP project ----------------------------------------------------------------

async function deleteMcpProjectData({ projectId, companyId }) {
  const byProject = { projectId, companyId };
  const del = async (Model, filter) => (await Model.deleteMany(filter)).deletedCount || 0;
  const { McpSuite } = require("../model/mcpTraceModel");

  // McpUsageEvent is deliberately NOT deleted: it's what the free-trial limits
  // count. Deleting it with the project would let anyone reset their usage by
  // deleting and recreating projects.
  return {
    project: await del(require("../model/McpProjectModel"), { _id: projectId, companyId }),
    tools: await del(require("../model/McpToolModel"), byProject),
    docs: await del(require("../model/McpDocModel"), byProject),
    tests: await del(require("../model/McpToolSuiteModel"), byProject),
    legacySuites: await del(McpSuite, byProject),
    qaRuns: await del(require("../model/McpQaRunModel"), byProject),
    bugs: await del(require("../model/McpBugModel"), byProject),
    loadRuns: await del(require("../model/McpLoadRunModel"), byProject),
    profileRuns: await del(require("../model/McpProfileRunModel"), byProject),
    securityRuns: await del(require("../model/McpSecurityRunModel"), byProject),
    watchers: await del(require("../model/McpWatcherModel"), { mcpProjectId: projectId, companyId }),
    watcherRuns: await del(require("../model/McpWatcherRunModel"), { mcpProjectId: projectId, companyId }),
  };
}

// --- GitHub ---------------------------------------------------------------------

// Whether GitHub can remove a single repo from this installation. An install
// granted "All repositories" has no per-repo list to remove from.
async function installationSelection(installationId) {
  try {
    const app = await getApp();
    const { data } = await app.octokit.request(
      "GET /app/installations/{installation_id}",
      { installation_id: Number(installationId) }
    );
    return data.repository_selection; // "selected" | "all"
  } catch (_) {
    return null; // unknown — let the removal itself report what's wrong
  }
}

/**
 * Take the app's access to one repo away, leaving the connection and every
 * other repo intact. Needs the USER's token: GitHub doesn't let an app remove
 * its own repo access.
 *
 * Throws with `githubStatus` on a GitHub refusal so the caller can explain it.
 */
async function removeRepoFromGithub({ userToken, installationId, owner, repo }) {
  const octokit = await getOctokit(Number(installationId));
  let repoId;
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
    repoId = data.id;
  } catch (err) {
    // Already gone from GitHub (deleted, or access already removed): nothing to
    // revoke, and the local cleanup should still happen.
    if (err.status === 404) return { removed: false, reason: "not_found" };
    throw err;
  }

  const res = await fetch(
    `https://api.github.com/user/installations/${Number(installationId)}/repositories/${repoId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (res.status === 204) return { removed: true };
  if (res.status === 404) return { removed: false, reason: "not_in_installation" };

  const err = new Error(`GitHub refused to remove ${owner}/${repo} (${res.status})`);
  err.githubStatus = res.status;
  err.githubBody = await res.text().catch(() => "");
  throw err;
}

module.exports = {
  deleteRepoData,
  linkedMcpProjectIds,
  deleteMcpProjectData,
  installationSelection,
  removeRepoFromGithub,
};
