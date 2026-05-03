const asyncHandler = require("express-async-handler");
const mcpLab = require("../services/mcpLabService.js");
const mcpDocs = require("../services/mcpDocService.js");
const mcpQa = require("../services/mcpQaService.js");
const mcpProjects = require("../services/mcpProjectService.js");
const mcpSmoke = require("../services/mcpSmokeService.js");
const { McpTrace, McpSuite } = require("../model/mcpTraceModel.js");
const McpDoc = require("../model/McpDocModel.js");
const McpBug = require("../model/McpBugModel.js");
const McpQaRun = require("../model/McpQaRunModel.js");
const McpProject = require("../model/McpProjectModel.js");
const McpUsageEvent = require("../model/McpUsageEventModel.js");

const FREE_LIMITS = {
  projects: 2,
  docs_generate: 3,
  qa_run: 5,
  smoke_generate: 3,
  smoke_run: 5,
};

const UPGRADE_MESSAGE =
  "Free trial limit reached. If you need more QA runs, smoke tests, or MCP docs, please contact the provider to upgrade to the paid version.";

function ctx(req) {
  return {
    userId: req.user._id,
    companyId: req.user.companyId,
  };
}

function requireCompany(req, res) {
  if (!req.user.companyId) {
    res.status(400).json({ message: "User has no company" });
    return false;
  }
  return true;
}

function monthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

async function requireMonthlyLimit(req, res, action) {
  const used = await McpUsageEvent.countDocuments({
    companyId: req.user.companyId,
    action,
    createdAt: { $gte: monthStart() },
  });
  if (used >= FREE_LIMITS[action]) {
    res.status(403).json({
      message: UPGRADE_MESSAGE,
      action,
      limit: FREE_LIMITS[action],
      used,
    });
    return false;
  }
  return true;
}

async function recordUsage(req, action, projectId) {
  await McpUsageEvent.create({
    action,
    projectId,
    userId: req.user._id,
    companyId: req.user.companyId,
  });
}

/**
 * POST /api/mcp-lab/connect
 */
const connectServer = asyncHandler(async (req, res) => {
  const config = req.body || {};
  const [tools, resources, prompts] = await Promise.all([
    mcpLab.listTools(config).catch((e) => ({ error: e.message })),
    mcpLab.listResources(config).catch(() => []),
    mcpLab.listPrompts(config).catch(() => []),
  ]);
  res.json({ server: config.name || config.url || "unnamed", tools, resources, prompts });
});

/**
 * POST /api/mcp-lab/tools
 */
const getTools = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const { projectId, config: bodyConfig } = req.body;
  if (projectId) {
    const tools = await mcpProjects.listProjectTools({
      projectId,
      companyId: req.user.companyId,
    });
    return res.json({ tools });
  }
  if (!bodyConfig)
    return res.status(400).json({ message: "config or projectId required" });
  const tools = await mcpLab.listTools(bodyConfig);
  res.json({ tools });
});

/**
 * POST /api/mcp-lab/projects
 */
const saveProject = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const { projectName, config, save = true, tags, sampleArgsByTool } = req.body;
  if (!projectName) return res.status(400).json({ message: "projectName required" });
  if (!config) return res.status(400).json({ message: "config required" });

  const existingProject = await McpProject.findOne({
    companyId: req.user.companyId,
    projectName,
  });
  if (!existingProject) {
    const projectCount = await McpProject.countDocuments({
      companyId: req.user.companyId,
    });
    if (projectCount >= FREE_LIMITS.projects) {
      return res.status(403).json({
        message: UPGRADE_MESSAGE,
        action: "projects",
        limit: FREE_LIMITS.projects,
        used: projectCount,
      });
    }
  }
  if (!(await requireMonthlyLimit(req, res, "docs_generate"))) return;

  const out = await mcpProjects.saveProject({
    projectName,
    config,
    ...ctx(req),
  });
  const projectId = out.project._id;

  const docsOut = await mcpDocs.generateDocs({
    config: out.config,
    projectId,
    save,
    tags: tags || [],
    sampleArgsByTool: sampleArgsByTool || {},
    ...ctx(req),
  });
  await recordUsage(req, "docs_generate", projectId);

  const overview = await mcpProjects.getProjectOverview({
    projectId,
    companyId: req.user.companyId,
  });

  res.status(201).json({
    projectId,
    ...overview,
    docsResult: docsOut,
  });
});

/** GET /api/mcp-lab/projects */
const listProjects = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const projects = await mcpProjects.listProjects({
    companyId: req.user.companyId,
  });
  res.json({ projects });
});

/** GET /api/mcp-lab/projects/:id */
const getProject = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const out = await mcpProjects.getProjectOverview({
    projectId: req.params.id,
    companyId: req.user.companyId,
  });
  res.json(out);
});

/** GET /api/mcp-lab/projects/:id/tools */
const listProjectTools = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const tools = await mcpProjects.listProjectTools({
    projectId: req.params.id,
    companyId: req.user.companyId,
  });
  res.json({ tools });
});

/** POST /api/mcp-lab/invoke */
const invokeTool = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const { config, toolName, args, tags } = req.body;
  if (!config || !toolName)
    return res.status(400).json({ message: "config and toolName required" });
  const result = await mcpLab.invokeTool({
    config,
    toolName,
    args,
    tags,
    ...ctx(req),
  });
  res.json(result);
});

/** POST /api/mcp-lab/run */
const runPrompt = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const { config, userPrompt, provider, model, tags } = req.body;
  if (!config || !userPrompt)
    return res.status(400).json({ message: "config and userPrompt required" });
  const result = await mcpLab.runPromptAgainstMcp({
    config,
    userPrompt,
    provider: provider || "openai",
    model,
    tags,
    ...ctx(req),
  });
  res.json(result);
});

/** POST /api/mcp-lab/judge/:traceId */
const judge = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const { traceId } = req.params;
  const { provider, model } = req.body || {};
  const trace = await mcpLab.judgeTrace({
    traceId,
    provider: provider || "openai",
    model,
    companyId: req.user.companyId,
  });
  res.json({ trace });
});

/** POST /api/mcp-lab/generate-cases */
const generateCases = asyncHandler(async (req, res) => {
  const { config, provider, model, count } = req.body;
  const out = await mcpLab.generateTestCases({
    config,
    provider: provider || "openai",
    model,
    count: count || 10,
  });
  res.json(out);
});

/** POST /api/mcp-lab/docs/generate */
const generateDocs = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const { projectId, provider, model, save = true, tags, sampleArgsByTool } = req.body;
  if (!projectId) return res.status(400).json({ message: "projectId required" });
  if (!(await requireMonthlyLimit(req, res, "docs_generate"))) return;

  const { config } = await mcpProjects.resolveConfig({
    projectId,
    companyId: req.user.companyId,
  });

  const out = await mcpDocs.generateDocs({
    config,
    projectId,
    provider: provider || "anthropic",
    model,
    save,
    tags: tags || [],
    sampleArgsByTool: sampleArgsByTool || {},
    ...ctx(req),
  });
  await recordUsage(req, "docs_generate", projectId);

  const overview = await mcpProjects.getProjectOverview({
    projectId,
    companyId: req.user.companyId,
  });

  res.json({
    ...out,
    projectId,
    project: overview?.project,
    tools: overview?.tools,
    docs: overview?.docs,
    bugs: overview?.bugs,
  });
});

/** GET /api/mcp-lab/docs */
const listDocs = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const docs = await mcpDocs.listDocs({
    projectId: req.query.projectId,
    serverName: req.query.serverName,
    serverUrl: req.query.serverUrl,
    toolName: req.query.toolName,
    limit: req.query.limit || 100,
    companyId: req.user.companyId,
  });
  res.json({ docs });
});

/** GET /api/mcp-lab/docs/:id */
const getDoc = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const doc = await McpDoc.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!doc) return res.status(404).json({ message: "Not found" });
  res.json({ doc });
});

/** DELETE /api/mcp-lab/docs/:id */
const deleteDoc = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const doc = await McpDoc.findOneAndDelete({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!doc) return res.status(404).json({ message: "Not found" });
  res.json({ ok: true });
});

/** POST /api/mcp-lab/qa/run */
const runQa = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const { projectId, toolName, sampleArgsByTool, save = true } = req.body;
  if (!projectId) return res.status(400).json({ message: "projectId required" });
  if (!(await requireMonthlyLimit(req, res, "qa_run"))) return;

  const { config } = await mcpProjects.resolveConfig({
    projectId,
    companyId: req.user.companyId,
  });

  const out = await mcpQa.runQa({
    config,
    projectId,
    toolName,
    sampleArgsByTool: sampleArgsByTool || {},
    maxCasesPerTool: 3,
    save,
    ...ctx(req),
  });
  await recordUsage(req, "qa_run", projectId);
  res.json(out);
});

/** GET /api/mcp-lab/qa/runs */
const listQaRuns = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const q = { companyId: req.user.companyId };
  if (req.query.projectId) q.projectId = req.query.projectId;
  if (req.query.serverName) q.serverName = req.query.serverName;

  const runs = await McpQaRun.find(q)
    .select("projectId serverName serverUrl transport summary generatedBy createdAt updatedAt")
    .sort({ createdAt: -1 });

  res.json({ runs });
});

/** GET /api/mcp-lab/qa/runs/:id */
const getQaRun = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const run = await McpQaRun.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!run) return res.status(404).json({ message: "Not found" });
  res.json({ run });
});

/** DELETE /api/mcp-lab/qa/runs/:id */
const deleteQaRun = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const run = await McpQaRun.findOneAndDelete({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!run) return res.status(404).json({ message: "Not found" });

  const bugs = await McpBug.deleteMany({
    qaRunId: run._id,
    companyId: req.user.companyId,
  });

  res.json({ ok: true, deletedBugCount: bugs.deletedCount || 0 });
});

/** POST /api/mcp-lab/projects/:id/smoke/generate */
const generateSmoke = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const { provider, model } = req.body || {};
  if (!(await requireMonthlyLimit(req, res, "smoke_generate"))) return;
  const out = await mcpSmoke.generateSmokeSuite({
    projectId: req.params.id,
    provider: provider || "anthropic",
    model,
    ...ctx(req),
  });
  await recordUsage(req, "smoke_generate", req.params.id);
  res.json(out);
});

/** POST /api/mcp-lab/projects/:id/smoke/run */
const runSmoke = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  if (!(await requireMonthlyLimit(req, res, "smoke_run"))) return;
  const suite = await McpSuite.findOne({
    projectId: req.params.id,
    kind: "smoke",
    companyId: req.user.companyId,
  });
  if (!suite) {
    return res
      .status(404)
      .json({ message: "No smoke suite for this project. Generate one first." });
  }
  const out = await mcpSmoke.runSmokeSuite({
    suiteId: suite._id,
    ...ctx(req),
  });
  await recordUsage(req, "smoke_run", req.params.id);
  res.json(out);
});

/** GET /api/mcp-lab/projects/:id/smoke */
const getSmoke = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const suite = await McpSuite.findOne({
    projectId: req.params.id,
    kind: "smoke",
    companyId: req.user.companyId,
  });
  res.json({ suite: suite || null });
});

/** GET /api/mcp-lab/bugs */
const listBugs = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const q = { companyId: req.user.companyId };
  if (req.query.projectId) q.projectId = req.query.projectId;
  if (req.query.toolName) q.toolName = req.query.toolName;
  if (req.query.status) q.status = req.query.status;
  const bugs = await McpBug.find(q).sort({ createdAt: -1 });
  res.json({ bugs });
});

/** PATCH /api/mcp-lab/bugs/:id/status */
const updateBugStatus = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const { status } = req.body;
  if (!["open", "ignored", "fixed"].includes(status)) {
    return res.status(400).json({ message: "invalid status" });
  }
  const bug = await McpBug.findOneAndUpdate(
    { _id: req.params.id, companyId: req.user.companyId },
    { $set: { status } },
    { new: true }
  );
  if (!bug) return res.status(404).json({ message: "Not found" });
  res.json({ bug });
});

/** DELETE /api/mcp-lab/bugs/:id */
const deleteBug = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const bug = await McpBug.findOneAndDelete({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!bug) return res.status(404).json({ message: "Not found" });
  res.json({ ok: true });
});

/** POST /api/mcp-lab/compare/:traceId */
const compare = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const { traceId } = req.params;
  const { apiUrl, apiResponse, provider, model } = req.body;
  const trace = await mcpLab.compareWithApi({
    traceId,
    apiUrl,
    apiResponse,
    provider: provider || "openai",
    model,
    companyId: req.user.companyId,
  });
  res.json({ trace });
});

/** GET /api/mcp-lab/traces */
const listTraces = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const { serverName, limit = 50 } = req.query;
  const q = { companyId: req.user.companyId };
  if (serverName) q.serverName = serverName;
  const traces = await McpTrace.find(q)
    .sort({ createdAt: -1 })
    .limit(Number(limit));
  res.json({ traces });
});

/** GET /api/mcp-lab/traces/:id */
const getTrace = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const trace = await McpTrace.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!trace) return res.status(404).json({ message: "Not found" });
  res.json({ trace });
});

/** DELETE /api/mcp-lab/traces/:id */
const deleteTrace = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const trace = await McpTrace.findOneAndDelete({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!trace) return res.status(404).json({ message: "Not found" });
  res.json({ ok: true });
});

// ----- Suites -----

const createSuite = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const suite = await McpSuite.create({
    ...req.body,
    userId: req.user._id,
    companyId: req.user.companyId,
  });
  res.status(201).json({ suite });
});

const listSuites = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const suites = await McpSuite.find({ companyId: req.user.companyId }).sort({
    createdAt: -1,
  });
  res.json({ suites });
});

const getSuite = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const suite = await McpSuite.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!suite) return res.status(404).json({ message: "Not found" });
  res.json({ suite });
});

const deleteSuite = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const suite = await McpSuite.findOneAndDelete({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!suite) return res.status(404).json({ message: "Not found" });
  res.json({ ok: true });
});

const runSuite = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const suite = await McpSuite.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!suite) return res.status(404).json({ message: "Suite not found" });

  const {
    provider = "openai",
    model,
    judgeProvider = "openai",
    judgeModel,
  } = req.body || {};

  const config = {
    name: suite.serverName,
    url: suite.serverUrl,
    transport: suite.transport,
  };

  const results = [];
  for (const testCase of suite.cases) {
    try {
      const run = await mcpLab.runPromptAgainstMcp({
        config,
        userPrompt: testCase.userPrompt,
        provider,
        model,
        tags: [`suite:${suite._id}`, `case:${testCase.name}`],
        ...ctx(req),
      });
      const judged = run.trace
        ? await mcpLab.judgeTrace({
            traceId: run.trace._id,
            provider: judgeProvider,
            model: judgeModel,
            companyId: req.user.companyId,
          })
        : null;

      const matchedTool =
        testCase.expectedTool && run.chosen?.name === testCase.expectedTool;

      results.push({
        case: testCase.name,
        expectedTool: testCase.expectedTool,
        actualTool: run.chosen?.name || null,
        toolMatch: !!matchedTool,
        judgeScore: judged?.judge?.score ?? null,
        judgeVerdict: judged?.judge?.verdict ?? null,
        traceId: run.trace?._id,
        error: run.error,
      });
    } catch (err) {
      results.push({ case: testCase.name, error: err.message });
    }
  }

  const passed = results.filter(
    (r) => r.judgeVerdict === "pass" && (!r.expectedTool || r.toolMatch)
  ).length;

  res.json({
    suiteId: suite._id,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  });
});

module.exports = {
  connectServer,
  getTools,
  saveProject,
  listProjects,
  getProject,
  listProjectTools,
  invokeTool,
  runPrompt,
  judge,
  generateCases,
  generateDocs,
  listDocs,
  getDoc,
  deleteDoc,
  runQa,
  listQaRuns,
  getQaRun,
  deleteQaRun,
  generateSmoke,
  runSmoke,
  getSmoke,
  listBugs,
  updateBugStatus,
  deleteBug,
  compare,
  listTraces,
  getTrace,
  deleteTrace,
  createSuite,
  listSuites,
  getSuite,
  deleteSuite,
  runSuite,
};
