const ApiWatcher = require("../model/ApiWatcherModel");
const McpWatcher = require("../model/McpWatcherModel");

// When a customer reconnects GitHub, the old installation dies and GitHub
// issues a NEW id. Everything Olivia stored against the old one — the watchers,
// which call GitHub on every merge — keeps pointing at an installation that no
// longer exists, and every run fails with a 404 nobody can read.
//
// Nothing in the product tells the customer that, and in a SaaS there is no one
// to fix the rows by hand. So whenever an installation shows up with its repo
// list (a fresh install, repos added, or the connect callback), the records for
// those exact repos are moved onto it.
async function repointToInstallation({ installationId, accountLogin, repos }) {
  const names = (repos || []).map((r) => r.repoName).filter(Boolean);
  if (!installationId || !accountLogin || !names.length) return { api: 0, mcp: 0 };

  const scope = {
    owner: accountLogin,
    repo: { $in: names },
    installationId: { $ne: installationId },
  };

  const [api, mcp] = await Promise.all([
    ApiWatcher.updateMany(scope, { $set: { installationId } }),
    McpWatcher.updateMany(scope, { $set: { installationId } }),
  ]);

  const moved = { api: api.modifiedCount || 0, mcp: mcp.modifiedCount || 0 };
  if (moved.api || moved.mcp) {
    console.log(
      `[installations] repointed to ${installationId} (${accountLogin}): ` +
        `${moved.api} API watcher(s), ${moved.mcp} MCP watcher(s)`
    );
  }
  return moved;
}

/**
 * The installation that currently covers this repo, straight from the
 * Installation records. Watchers resolve through this instead of trusting the
 * id they were created with — belt and braces next to repointToInstallation,
 * for the case where a webhook was missed entirely.
 */
async function liveInstallationIdFor({ owner, repo, fallback = null }) {
  const Installation = require("../model/Installation");
  const inst = await Installation.findOne({
    accountLogin: owner,
    "repos.repoName": repo,
  })
    .select("installationId")
    .lean();
  return inst?.installationId || fallback;
}

module.exports = { repointToInstallation, liveInstallationIdFor };
