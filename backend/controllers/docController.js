const Doc = require("../model/DocModel");

async function getDocs(req, res) {
  if (!req.user.companyId) {
    return res.status(400).json({ message: "User has no company" });
  }
  const { owner, repo, includeUnmounted, branch } = req.query;

  const filter = { companyId: req.user.companyId };
  if (repo) filter.repo = repo;
  if (owner) filter.owner = owner;
  // One repo can hold several environments (main, dev). Without this the page
  // would show every environment's endpoints mixed together.
  if (branch) filter.branch = branch;
  // Route files that exist in the repo but nothing ever mounts them are
  // dead code — hide them by default so the list matches the live API.
  // Pass ?includeUnmounted=true to see them (e.g. a "show dead code" view).
  if (includeUnmounted !== "true") filter.mounted = { $ne: false };

  const docs = await Doc.find(filter).sort({ createdAt: -1 });
  res.json(docs);
}

/**
 * The environments a repo has docs for, newest activity first — what the tabs
 * at the top of the docs page are built from.
 */
async function listDocEnvironments(req, res) {
  if (!req.user.companyId) {
    return res.status(400).json({ message: "User has no company" });
  }
  const { owner, repo } = req.query;
  if (!owner || !repo) {
    return res.status(400).json({ message: "owner and repo are required" });
  }
  const rows = await Doc.aggregate([
    { $match: { companyId: req.user.companyId, owner, repo } },
    {
      $group: {
        _id: { $ifNull: ["$branch", ""] },
        endpoints: { $sum: 1 },
        updatedAt: { $max: "$updatedAt" },
      },
    },
    { $sort: { updatedAt: -1 } },
  ]);
  res.json(
    rows.map((r) => ({
      branch: r._id || "",
      endpoints: r.endpoints,
      updatedAt: r.updatedAt,
    }))
  );
}

async function deleteDoc(req, res) {
  if (!req.user.companyId) {
    return res.status(400).json({ message: "User has no company" });
  }
  const result = await Doc.findOneAndDelete({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!result) return res.status(404).json({ message: "Doc not found" });
  res.json({ message: "Doc deleted" });
}

module.exports = {
  listDocEnvironments, getDocs, deleteDoc };
