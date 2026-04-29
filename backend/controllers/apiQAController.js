const ApiQaConfig = require("../model/ApiQaConfig");
const Bug = require("../model/BugModel");
const Doc = require("../model/DocModel");
const TestRun = require("../model/TestRunModel");
const { encrypt, maskSecret, decrypt } = require("../services/secretCrypto");
const apiQAService = require("../services/apiQAService");

function serializeConfig(cfg) {
  if (!cfg) return null;
  const auth = cfg.auth || { type: "none" };
  return {
    _id: cfg._id,
    owner: cfg.owner,
    repo: cfg.repo,
    baseUrl: cfg.baseUrl,
    auth: {
      type: auth.type,
      headerName: auth.headerName || "",
      username: auth.username || "",
      valueMasked: maskSecret(decrypt(auth.valueEncrypted)),
      passwordMasked: maskSecret(decrypt(auth.passwordEncrypted)),
    },
    defaultHeaders: cfg.defaultHeaders
      ? Object.fromEntries(cfg.defaultHeaders)
      : {},
    updatedAt: cfg.updatedAt,
  };
}

async function getConfig(req, res) {
  const { owner, repo } = req.params;
  const cfg = await ApiQaConfig.findOne({
    userId: req.user._id,
    owner,
    repo,
  });
  if (!cfg) return res.status(404).json({ message: "No config" });
  res.json(serializeConfig(cfg));
}

async function upsertConfig(req, res) {
  const { owner, repo } = req.params;
  const { baseUrl, auth = {}, defaultHeaders = {} } = req.body;

  if (!baseUrl) {
    return res.status(400).json({ message: "baseUrl is required" });
  }

  const update = {
    userId: req.user._id,
    owner,
    repo,
    baseUrl,
    defaultHeaders,
    updatedAt: new Date(),
    auth: {
      type: auth.type || "none",
      headerName: auth.headerName || "",
      username: auth.username || "",
      valueEncrypted: auth.value ? encrypt(auth.value) : "",
      passwordEncrypted: auth.password ? encrypt(auth.password) : "",
    },
  };

  const cfg = await ApiQaConfig.findOneAndUpdate(
    { userId: req.user._id, owner, repo },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  res.json(serializeConfig(cfg));
}

async function findBugs(req, res) {
  const { docId } = req.params;
  try {
    const result = await apiQAService.findBugs({
      docId,
      userId: req.user._id,
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("findBugs error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

async function getBugs(req, res) {
  const { docId } = req.params;
  const bugs = await Bug.find({ userId: req.user._id, docId }).sort({
    createdAt: -1,
  });
  res.json(bugs);
}

async function deleteBug(req, res) {
  await Bug.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
  res.json({ message: "Bug deleted" });
}

async function getCollection(req, res) {
  const { docId } = req.params;
  const doc = await Doc.findOne({ _id: docId, userId: req.user._id });
  if (!doc) return res.status(404).json({ message: "Doc not found" });
  const config = await ApiQaConfig.findOne({
    userId: req.user._id,
    owner: doc.owner,
    repo: doc.repo,
  });
  if (!config)
    return res.status(400).json({ message: "No QA config for this repo" });

  const { cases } = await apiQAService.generateTestCases(doc);
  const collection = apiQAService.buildPostmanCollection({
    doc,
    config,
    testCases: cases,
  });
  res.json(collection);
}

async function listRuns(req, res) {
  const { docId } = req.params;
  const runs = await TestRun.find(
    { userId: req.user._id, docId },
    { executions: 0 } // omit heavy executions on list view
  ).sort({ createdAt: -1 });
  res.json(runs);
}

async function getRun(req, res) {
  const run = await TestRun.findOne({
    _id: req.params.id,
    userId: req.user._id,
  });
  if (!run) return res.status(404).json({ message: "Run not found" });
  res.json(run);
}

module.exports = {
  getConfig,
  upsertConfig,
  findBugs,
  getBugs,
  deleteBug,
  getCollection,
  listRuns,
  getRun,
};
