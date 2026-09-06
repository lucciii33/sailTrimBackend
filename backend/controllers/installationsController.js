const Installation = require("../model/Installation");
const {
  uninstallApp,
  fetchInstallationReposForModel,
} = require("../services/githubService");
const { logEvent } = require("../services/auditLogger");

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
        inst.repos = await fetchInstallationReposForModel(inst.installationId);
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

module.exports = {
  listInstallations,
  syncInstallations,
  disconnectInstallation,
};
