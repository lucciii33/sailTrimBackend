const Installation = require("../model/Installation");

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

module.exports = { listInstallations };
