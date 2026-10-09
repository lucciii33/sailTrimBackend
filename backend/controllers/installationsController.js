const Installation = require("../model/Installation");
const {
  uninstallApp,
  fetchInstallationReposForModel,
  withoutRemovedRepos,
} = require("../services/githubService");
const { logEvent } = require("../services/auditLogger");
// DISABLED: GitHub only lets a classic PAT remove a repo from an app
// installation, so the user-token path can't work (see removeRepo).
// const {
//   getUserGithubToken,
//   clearUserGithubToken,
// } = require("../services/githubUserTokenService");
const removal = require("../services/repoRemovalService");

// Which installations a user is allowed to see.
//
// An installation is stored against the person who connected it, but a GitHub
// App installed on an ORG belongs to the whole workspace — a teammate who never
// clicked "Connect" still has to see those repos. Filtering on userId alone is
// what made a member see nothing while their colleague saw everything, and it
// made the same database look different depending on who was logged in.
//
// userId is kept (and matched as both ObjectId and string, since older rows
// stored it either way) so a personal install with no company still resolves.
function visibilityFilter(user) {
  const uid = user._id;
  const clauses = [{ userId: uid }, { userId: String(uid) }];
  if (user.companyId) clauses.push({ companyId: user.companyId });
  return { $or: clauses };
}

function toRepoRows(installations) {
  return installations.flatMap((inst) =>
    (inst.repos || []).map((r) => ({
      installationId: inst.installationId,
      owner: inst.accountLogin,
      accountType: inst.accountType,
      repo: r.repoName,
      fullName: r.repoFullName,
    }))
  );
}

async function listInstallations(req, res) {
  const installations = await Installation.find(
    visibilityFilter(req.user)
  ).sort({ installedAt: -1 });

  res.json(toRepoRows(installations));
}

// Re-read the repo list from GitHub for every install the user can see. The
// stored `repos` array is a snapshot taken when the app was connected, so a repo
// added later never appears until something refreshes it — this is the manual
// escape hatch for when a webhook never arrived.
async function syncInstallations(req, res) {
  const installations = await Installation.find(visibilityFilter(req.user));

  const failed = [];
  await Promise.all(
    installations.map(async (inst) => {
      try {
        inst.repos = withoutRemovedRepos(
          await fetchInstallationReposForModel(inst.installationId),
          inst.removedRepos
        );
        await inst.save();
      } catch (err) {
        // One dead installation (revoked on GitHub, suspended) must not sink
        // the refresh for the others — report it and keep the rest.
        console.error(
          `[installations] sync failed for ${inst.installationId}:`,
          err.message
        );
        failed.push(inst.installationId);
      }
    })
  );

  const fresh = await Installation.find(visibilityFilter(req.user)).sort({
    installedAt: -1,
  });

  res.json({ repos: toRepoRows(fresh), synced: installations.length, failed });
}

// Hard disconnect: actually revokes the GitHub App's access (not just a
// local flag). Docs/bugs already generated for these repos are left alone —
// only the Installation record (the connection itself) is removed. If the
// user wants these repos back later, they go through Connect GitHub again
// and get a new installationId, same as a first-time setup.
async function disconnectInstallation(req, res) {
  const { installationId } = req.params;

  const installation = await Installation.findOne({
    installationId,
    ...visibilityFilter(req.user),
  });

  if (!installation) {
    return res.status(404).json({ message: "Installation not found" });
  }

  try {
    await uninstallApp(installation.installationId);
  } catch (err) {
    if (err.status !== 404) {
      console.error("Error uninstalling GitHub App:", err);
      return res
        .status(502)
        .json({ message: "Could not revoke GitHub access. Try again." });
    }
    // Already uninstalled on GitHub's side — fine, just clean up locally.
  }

  await Installation.deleteOne({ _id: installation._id });

  await logEvent({
    event: "github_installation_disconnected",
    req,
    user: req.user,
    targetType: "Installation",
    targetId: String(installation.installationId),
    metadata: { accountLogin: installation.accountLogin },
  });

  res.json({ success: true });
}

// Remove ONE repo from Olivia entirely, from inside Olivia: delete everything
// Olivia stored for it and take it off the list. The connection and every other
// repo stay as they are.
//
// GitHub keeps the app's access to the repo: its API only lets a classic PAT
// drop a single repo from an installation — not the app, not the signed-in
// user's token. So the repo goes on `removedRepos`, which keeps sync, webhooks
// and the connect callback from listing it again. Reconnecting it (restoreRepo)
// starts from zero because its data is gone.
async function removeRepo(req, res) {
  const { installationId, repo } = req.params;
  const deleteMcpProjects =
    req.body?.deleteMcpProjects === true || req.query.deleteMcpProjects === "true";

  if (!req.user.companyId) {
    return res.status(400).json({ message: "User has no company" });
  }

  const installation = await Installation.findOne({
    installationId,
    ...visibilityFilter(req.user),
  });
  if (!installation) {
    return res.status(404).json({ message: "Installation not found" });
  }
  const owner = installation.accountLogin;
  if (!(installation.repos || []).some((r) => r.repoName === repo)) {
    return res.status(404).json({ message: `${owner}/${repo} isn't connected.` });
  }

  // DISABLED: GitHub rejects this for app user tokens (403), see above.
  // const userToken = await getUserGithubToken(req.user._id);
  // if (!userToken) {
  //   return res.status(409).json({
  //     code: "GITHUB_AUTH_REQUIRED",
  //     message: "Sign in with GitHub once so Olivia can remove this repo.",
  //   });
  // }
  //
  // if ((await removal.installationSelection(installationId)) === "all") {
  //   return res.status(409).json({
  //     code: "INSTALLATION_ALL_REPOS",
  //     message:
  //       `Olivia has access to every repository in ${owner}, so a single one can't be removed. ` +
  //       `Disconnect ${owner} and reconnect choosing only the repositories you want.`,
  //   });
  // }
  //
  // try {
  //   await removal.removeRepoFromGithub({ userToken, installationId, owner, repo });
  // } catch (err) {
  //   if (err.githubStatus === 401) {
  //     await clearUserGithubToken(req.user._id).catch(() => {});
  //     return res.status(409).json({
  //       code: "GITHUB_AUTH_REQUIRED",
  //       message: "Your GitHub sign-in expired. Sign in again to remove this repo.",
  //     });
  //   }
  //   if (err.githubStatus === 403) {
  //     return res.status(403).json({
  //       message:
  //         `GitHub didn't allow it: only an owner or admin of ${owner} can remove its repositories. ` +
  //         `Nothing was deleted.`,
  //     });
  //   }
  //   console.error("[installations] remove repo on GitHub failed:", err.message, err.githubBody || "");
  //   return res.status(502).json({
  //     message: "Couldn't remove the repo on GitHub. Nothing was deleted — try again.",
  //   });
  // }

  const companyId = req.user.companyId;
  const mcpProjectIds = deleteMcpProjects
    ? await removal.linkedMcpProjectIds({ owner, repo, companyId })
    : [];
  const deleted = await removal.deleteRepoData({ owner, repo, companyId, installationId });
  for (const projectId of mcpProjectIds) {
    await removal.deleteMcpProjectData({ projectId, companyId });
  }

  const removedRow = (installation.repos || []).find((r) => r.repoName === repo);
  installation.repos = (installation.repos || []).filter((r) => r.repoName !== repo);
  installation.removedRepos = [
    ...(installation.removedRepos || []).filter((r) => r.repoName !== repo),
    {
      repoName: repo,
      repoFullName: removedRow?.repoFullName || `${owner}/${repo}`,
      removedAt: new Date(),
    },
  ];
  await installation.save();

  await logEvent({
    event: "github_repo_removed",
    req,
    user: req.user,
    targetType: "Installation",
    targetId: String(installation.installationId),
    metadata: { owner, repo, deleteMcpProjects, mcpProjectsDeleted: mcpProjectIds.length },
  });

  res.json({
    success: true,
    owner,
    repo,
    deleted,
    mcpProjectsDeleted: mcpProjectIds.length,
  });
}

// Repos removed inside Olivia, so the UI can offer to reconnect them.
async function listRemovedRepos(req, res) {
  const installations = await Installation.find(visibilityFilter(req.user));
  res.json(
    installations.flatMap((inst) =>
      (inst.removedRepos || []).map((r) => ({
        installationId: inst.installationId,
        owner: inst.accountLogin,
        repo: r.repoName,
        fullName: r.repoFullName,
        removedAt: r.removedAt,
      }))
    )
  );
}

// Reconnect a repo removed inside Olivia. It comes back empty — its data was
// deleted on removal — only if GitHub still gives the app access to it.
async function restoreRepo(req, res) {
  const { installationId, repo } = req.params;

  const installation = await Installation.findOne({
    installationId,
    ...visibilityFilter(req.user),
  });
  if (!installation) {
    return res.status(404).json({ message: "Installation not found" });
  }
  const owner = installation.accountLogin;

  let ghRepos;
  try {
    ghRepos = await fetchInstallationReposForModel(installation.installationId);
  } catch (err) {
    console.error("[installations] restore repo: GitHub read failed:", err.message);
    return res.status(502).json({ message: "Couldn't reach GitHub. Try again." });
  }
  if (!ghRepos.some((r) => r.repoName === repo)) {
    return res.status(404).json({
      message: `Olivia no longer has access to ${owner}/${repo} on GitHub. Connect GitHub again and select it.`,
    });
  }

  installation.removedRepos = (installation.removedRepos || []).filter(
    (r) => r.repoName !== repo
  );
  installation.repos = withoutRemovedRepos(ghRepos, installation.removedRepos);
  await installation.save();

  await logEvent({
    event: "github_repo_restored",
    req,
    user: req.user,
    targetType: "Installation",
    targetId: String(installation.installationId),
    metadata: { owner, repo },
  });

  res.json({ success: true, owner, repo });
}

module.exports = {
  listInstallations,
  syncInstallations,
  disconnectInstallation,
  removeRepo,
  listRemovedRepos,
  restoreRepo,
};
