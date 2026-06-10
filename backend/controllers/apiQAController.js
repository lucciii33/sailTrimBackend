const ApiQaConfig = require("../model/ApiQaConfig");
const ApiProject = require("../model/ApiProject");
const Bug = require("../model/BugModel");
const Doc = require("../model/DocModel");
const TestRun = require("../model/TestRunModel");
const { encrypt, maskSecret, decrypt } = require("../services/secretCrypto");
const apiQAService = require("../services/apiQAService");
const SuiteRun = require("../model/SuiteRunModel");
const openApiService = require("../services/openApiService");
const { getUserAnthropicClient } = require("../services/userKeyService");

function requireCompany(req, res) {
  if (!req.user.companyId) {
    res.status(400).json({ message: "User has no company" });
    return false;
  }
  return true;
}

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
  if (!requireCompany(req, res)) return;
  const { owner, repo } = req.params;
  const cfg = await ApiQaConfig.findOne({
    companyId: req.user.companyId,
    owner,
    repo,
  });
  if (!cfg) return res.status(404).json({ message: "No config" });
  res.json(serializeConfig(cfg));
}

async function upsertConfig(req, res) {
  if (!requireCompany(req, res)) return;
  const { owner, repo } = req.params;
  const { baseUrl, auth = {}, defaultHeaders = {} } = req.body;

  if (!baseUrl) {
    return res.status(400).json({ message: "baseUrl is required" });
  }

  const update = {
    userId: req.user._id,
    companyId: req.user.companyId,
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
    { companyId: req.user.companyId, owner, repo },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  res.json(serializeConfig(cfg));
}

async function findBugs(req, res) {
  if (!requireCompany(req, res)) return;
  const { docId } = req.params;
  try {
    const anthropicClient = await getUserAnthropicClient(req.user._id);
    const result = await apiQAService.findBugs({
      docId,
      userId: req.user._id,
      companyId: req.user.companyId,
      anthropicClient,
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("findBugs error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

async function getBugs(req, res) {
  if (!requireCompany(req, res)) return;
  const { docId } = req.params;
  const bugs = await Bug.find({
    companyId: req.user.companyId,
    docId,
  }).sort({ createdAt: -1 });
  res.json(bugs);
}

async function deleteBug(req, res) {
  if (!requireCompany(req, res)) return;
  await Bug.findOneAndDelete({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  res.json({ message: "Bug deleted" });
}

// Mark a bug open / fixed (done) / ignored.
async function updateBugStatus(req, res) {
  if (!requireCompany(req, res)) return;
  const { status } = req.body;
  if (!["open", "fixed", "ignored"].includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }
  const bug = await Bug.findOneAndUpdate(
    { _id: req.params.id, companyId: req.user.companyId },
    { status },
    { new: true }
  );
  if (!bug) return res.status(404).json({ message: "Bug not found" });
  res.json(bug);
}

async function getCollection(req, res) {
  if (!requireCompany(req, res)) return;
  const { docId } = req.params;
  const doc = await Doc.findOne({
    _id: docId,
    companyId: req.user.companyId,
  });
  if (!doc) return res.status(404).json({ message: "Doc not found" });
  const config = await ApiQaConfig.findOne({
    companyId: req.user.companyId,
    owner: doc.owner,
    repo: doc.repo,
  });
  if (!config)
    return res.status(400).json({ message: "No QA config for this repo" });

  const anthropicClient = await getUserAnthropicClient(req.user._id);
  const { cases } = await apiQAService.generateTestCases(doc, { anthropicClient });
  const collection = apiQAService.buildPostmanCollection({
    doc,
    config,
    testCases: cases,
  });
  res.json(collection);
}

async function listRuns(req, res) {
  if (!requireCompany(req, res)) return;
  const { docId } = req.params;
  const runs = await TestRun.find(
    { companyId: req.user.companyId, docId },
    { executions: 0 }
  ).sort({ createdAt: -1 });
  res.json(runs);
}

async function getRun(req, res) {
  if (!requireCompany(req, res)) return;
  const run = await TestRun.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!run) return res.status(404).json({ message: "Run not found" });
  res.json(run);
}

// ======================= Spec-import (API Project) flow =======================

function serializeProject(p) {
  if (!p) return null;
  const auth = p.auth || { type: "none" };
  return {
    _id: p._id,
    name: p.name,
    title: p.title,
    version: p.version,
    source: p.source,
    baseUrl: p.baseUrl || "",
    auth: {
      type: auth.type || "none",
      headerName: auth.headerName || "",
      username: auth.username || "",
      valueMasked: maskSecret(decrypt(auth.valueEncrypted)),
      passwordMasked: maskSecret(decrypt(auth.passwordEncrypted)),
    },
    // Non-secret vars show their value; secret ones are masked.
    variables: (p.variables || []).map((v) => ({
      key: v.key,
      secret: !!v.secret,
      value: v.secret ? maskSecret(decrypt(v.value)) : v.value,
    })),
    github: p.github || {},
    updatedAt: p.updatedAt,
  };
}

// Paste a Swagger/OpenAPI spec → creates/updates an ApiProject + its endpoints.
async function importProjectSpec(req, res) {
  if (!requireCompany(req, res)) return;
  const { specText, projectId } = req.body;
  if (!specText) {
    return res.status(400).json({ message: "specText is required" });
  }
  try {
    const result = await openApiService.importSpec({
      specText,
      projectId, // optional — re-import into an existing project
      userId: req.user._id,
      companyId: req.user.companyId,
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("importProjectSpec error:", err);
    res.status(status).json({ message: err.message || "Import failed" });
  }
}

async function listProjects(req, res) {
  if (!requireCompany(req, res)) return;
  const projects = await ApiProject.find({
    companyId: req.user.companyId,
  }).sort({ updatedAt: -1 });
  res.json(projects.map(serializeProject));
}

async function getProjectDocs(req, res) {
  if (!requireCompany(req, res)) return;
  const project = await ApiProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });
  const docs = await Doc.find({
    companyId: req.user.companyId,
    projectId: project._id,
  }).sort({ section: 1, path: 1 });
  res.json({ project: serializeProject(project), docs });
}

// Set baseUrl + auth + environment variables on a project. Secrets are
// encrypted at rest.
async function setProjectAuth(req, res) {
  if (!requireCompany(req, res)) return;
  const { baseUrl, auth = {}, variables } = req.body;
  const project = await ApiProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });

  if (baseUrl != null) project.baseUrl = baseUrl;
  project.auth = {
    type: auth.type || "none",
    headerName: auth.headerName || "",
    username: auth.username || "",
    // Only overwrite the secret when a new value is supplied.
    valueEncrypted: auth.value
      ? encrypt(auth.value)
      : project.auth?.valueEncrypted || "",
    passwordEncrypted: auth.password
      ? encrypt(auth.password)
      : project.auth?.passwordEncrypted || "",
  };

  // Environment variables: encrypt secret ones; keep an unchanged secret if the
  // client sent a blank/masked value (so editing other fields doesn't wipe it).
  if (Array.isArray(variables)) {
    const prev = new Map((project.variables || []).map((v) => [v.key, v]));
    project.variables = variables
      .filter((v) => v && v.key)
      .map((v) => {
        if (!v.secret) return { key: v.key, value: v.value ?? "", secret: false };
        const incoming = v.value;
        const looksMasked = !incoming || /\*/.test(incoming);
        const value = looksMasked
          ? prev.get(v.key)?.value || ""
          : encrypt(incoming);
        return { key: v.key, value, secret: true };
      });
  }

  project.updatedAt = new Date();
  await project.save();
  res.json(serializeProject(project));
}

// One Postman collection for a whole section, ready for Newman.
async function getProjectSectionCollection(req, res) {
  if (!requireCompany(req, res)) return;
  const section = req.query.section;
  if (!section) {
    return res.status(400).json({ message: "section query param required" });
  }
  const project = await ApiProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });
  const docs = await Doc.find({
    companyId: req.user.companyId,
    projectId: project._id,
    section,
  });
  if (docs.length === 0) {
    return res.status(404).json({ message: "No endpoints in this section" });
  }
  const collection = openApiService.buildSectionCollection({
    section,
    docs,
    baseUrl: project.baseUrl,
  });
  res.json(collection);
}

async function findBugsForSection(req, res) {
  if (!requireCompany(req, res)) return;
  const { id, section } = req.params;
  try {
    const anthropicClient = await getUserAnthropicClient(req.user._id);
    const result = await apiQAService.findBugsForSection({
      projectId: id,
      section: decodeURIComponent(section),
      userId: req.user._id,
      companyId: req.user.companyId,
      anthropicClient,
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("findBugsForSection error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

async function listSuiteRuns(req, res) {
  if (!requireCompany(req, res)) return;
  const { id } = req.params;
  const { section } = req.query;
  const filter = { companyId: req.user.companyId, projectId: id };
  if (section) filter.section = decodeURIComponent(section);
  const runs = await SuiteRun.find(filter, { executions: 0 }).sort({ createdAt: -1 });
  res.json(runs);
}

async function getSuiteRun(req, res) {
  if (!requireCompany(req, res)) return;
  const run = await SuiteRun.findOne({ _id: req.params.id, companyId: req.user.companyId });
  if (!run) return res.status(404).json({ message: "Suite run not found" });
  res.json(run);
}

async function deleteProject(req, res) {
  if (!requireCompany(req, res)) return;
  const { id } = req.params;
  const project = await ApiProject.findOne({ _id: id, companyId: req.user.companyId });
  if (!project) return res.status(404).json({ message: "Project not found" });
  await Doc.deleteMany({ apiProjectId: id });
  await Bug.deleteMany({ apiProjectId: id });
  await ApiProject.deleteOne({ _id: id });
  res.json({ deleted: true });
}

module.exports = {
  getConfig,
  upsertConfig,
  importProjectSpec,
  listProjects,
  getProjectDocs,
  deleteProject,
  setProjectAuth,
  getProjectSectionCollection,
  findBugs,
  findBugsForSection,
  getBugs,
  deleteBug,
  updateBugStatus,
  getCollection,
  listRuns,
  getRun,
  listSuiteRuns,
  getSuiteRun,
};
