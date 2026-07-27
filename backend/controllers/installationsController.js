const Installation = require("../model/Installation");
const { uninstallApp } = require("../services/githubService");
const { logEvent } = require("../services/auditLogger");

async function listInstallations(req, res) {
  const uid = req.user._id;
  const installations = await Installation.find({
    $or: [{ userId: uid }, { userId: String(uid) }],
  }).sort({ installedAt: -1 });

  const repos = installations.flatMap((inst) =>
    (inst.repos || []).map((r) => ({
      installationId: inst.installationId,
      owner: inst.accountLogin,
      accountType: inst.accountType,
      repo: r.repoName,
      fullName: r.repoFullName,
    }))
  );

  res.json(repos);
}

// Hard disconnect: actually revokes the GitHub App's access (not just a
// local flag). Docs/bugs already generated for these repos are left alone —
// only the Installation record (the connection itself) is removed. If the
// user wants these repos back later, they go through Connect GitHub again
// and get a new installationId, same as a first-time setup.
async function disconnectInstallation(req, res) {
  const uid = req.user._id;
  const { installationId } = req.params;

  const installation = await Installation.findOne({
    installationId,
    $or: [{ userId: uid }, { userId: String(uid) }],
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

module.exports = { listInstallations, disconnectInstallation };
