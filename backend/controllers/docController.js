const Doc = require("../model/DocModel");

async function getDocs(req, res) {
  if (!req.user.companyId) {
    return res.status(400).json({ message: "User has no company" });
  }
  const { owner, repo, includeUnmounted } = req.query;

  const filter = { companyId: req.user.companyId };
  if (repo) filter.repo = repo;
  if (owner) filter.owner = owner;
  // Route files that exist in the repo but nothing ever mounts them are
  // dead code — hide them by default so the list matches the live API.
  // Pass ?includeUnmounted=true to see them (e.g. a "show dead code" view).
  if (includeUnmounted !== "true") filter.mounted = { $ne: false };

  const docs = await Doc.find(filter).sort({ createdAt: -1 });
  res.json(docs);
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

module.exports = { getDocs, deleteDoc };
