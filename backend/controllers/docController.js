const Doc = require("../model/DocModel");

async function getDocs(req, res) {
  const { owner, repo } = req.query;

  const filter = { userId: req.user._id };
  if (repo) filter.repo = repo;
  if (owner) filter.owner = owner;

  const docs = await Doc.find(filter).sort({ createdAt: -1 });
  res.json(docs);
}

async function deleteDoc(req, res) {
  await Doc.findByIdAndDelete(req.params.id);
  res.json({ message: "Doc deleted" });
}

module.exports = { getDocs, deleteDoc };
