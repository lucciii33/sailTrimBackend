const asyncHandler = require("express-async-handler");
const mcpLab = require("../services/mcpLabService.js");
const mcpDocs = require("../services/mcpDocService.js");
const mcpQa = require("../services/mcpQaService.js");
const mcpProjects = require("../services/mcpProjectService.js");
const { McpTrace, McpSuite } = require("../model/mcpTraceModel.js");
const McpDoc = require("../model/McpDocModel.js");
const McpBug = require("../model/McpBugModel.js");

/**
 * POST /api/mcp-lab/connect
 * body: { transport, url?, command?, args?, env?, name? }
 * Probes a server and returns tools / resources / prompts in one shot.
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
 * body: { config }
 */
const getTools = asyncHandler(async (req, res) => {
  const { projectId, config: bodyConfig } = req.body;
  if (projectId) {
    const tools = await mcpProjects.listProjectTools({
      projectId,
      userId: req.user?._id,
    });
    return res.json({ tools });
  }

  const config = bodyConfig;
  if (!config) return res.status(400).json({ message: "config or projectId required" });
  const tools = await mcpLab.listTools(config);
  res.json({ tools });
});

/**
 * POST /api/mcp-lab/projects
 * body: { config, save?, tags?, sampleArgsByTool? }
 * Saves an MCP project, stores tools, and generates docs under that project.
 */
const saveProject = asyncHandler(async (req, res) => {
  const { projectName, config, save = true, tags, sampleArgsByTool } = req.body;
  if (!projectName) return res.status(400).json({ message: "projectName required" });
  if (!config) return res.status(400).json({ message: "config required" });
  const out = await mcpProjects.saveProject({
    projectName,
    config,
    userId: req.user?._id,
  });
  const projectId = out.project._id;

  const docsOut = await mcpDocs.generateDocs({
    config: out.project.config,
    projectId,
    save,
    tags: tags || [],
    sampleArgsByTool: sampleArgsByTool || {},
    userId: req.user?._id,
  });

  const overview = await mcpProjects.getProjectOverview({
    projectId,
    userId: req.user?._id,
  });

  res.status(201).json({
    projectId,
    ...overview,
    docsResult: docsOut,
  });
});

/** GET /api/mcp-lab/projects */
const listProjects = asyncHandler(async (req, res) => {
  const projects = await mcpProjects.listProjects({ userId: req.user?._id });
  res.json({ projects });
});

/** GET /api/mcp-lab/projects/:id */
const getProject = asyncHandler(async (req, res) => {
  const out = await mcpProjects.getProjectOverview({
    projectId: req.params.id,
    userId: req.user?._id,
  });
  res.json(out);
});

/** GET /api/mcp-lab/projects/:id/tools */
const listProjectTools = asyncHandler(async (req, res) => {
  const tools = await mcpProjects.listProjectTools({
    projectId: req.params.id,
    userId: req.user?._id,
  });
  res.json({ tools });
});

/**
 * POST /api/mcp-lab/invoke
 * body: { config, toolName, args, tags? }
 * Direct manual tool call (playground mode).
 */
const invokeTool = asyncHandler(async (req, res) => {
  const { config, toolName, args, tags } = req.body;
  if (!config || !toolName)
    return res.status(400).json({ message: "config and toolName required" });
  const result = await mcpLab.invokeTool({ config, toolName, args, tags });
  res.json(result);
});

/**
 * POST /api/mcp-lab/run
 * body: { config, userPrompt, provider: "openai"|"anthropic", model?, tags? }
 * LLM-driven: the LLM picks the tool and calls it.
 */
const runPrompt = asyncHandler(async (req, res) => {
  const { config, userPrompt, provider, model, tags } = req.body;
  if (!config || !userPrompt)
    return res.status(400).json({ message: "config and userPrompt required" });
  const result = await mcpLab.runPromptAgainstMcp({
    config,
    userPrompt,
    provider: provider || "openai",
    model,
    tags,
  });
  res.json(result);
});

/**
 * POST /api/mcp-lab/judge/:traceId
 * body: { provider?, model? }
 */
const judge = asyncHandler(async (req, res) => {
  const { traceId } = req.params;
  const { provider, model } = req.body || {};
  const trace = await mcpLab.judgeTrace({
    traceId,
    provider: provider || "openai",
    model,
  });
  res.json({ trace });
});

/**
 * POST /api/mcp-lab/generate-cases
 * body: { config, provider?, model?, count? }
 */
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

/**
 * POST /api/mcp-lab/docs/generate
 * body: { config, provider?, model?, save?, tags? }
 * Generates product-ready docs from MCP tool schemas.
 */
const generateDocs = asyncHandler(async (req, res) => {
  const { projectId, provider, model, save = true, tags, sampleArgsByTool } = req.body;
  if (!projectId) return res.status(400).json({ message: "projectId required" });

  const { config } = await mcpProjects.resolveConfig({
    projectId,
    userId: req.user?._id,
  });

  const out = await mcpDocs.generateDocs({
    config,
    projectId,
    provider: provider || "anthropic",
    model,
    save,
    tags: tags || [],
    sampleArgsByTool: sampleArgsByTool || {},
    userId: req.user?._id,
  });

  const overview = projectId
    ? await mcpProjects.getProjectOverview({ projectId, userId: req.user?._id })
    : null;

  res.json({
    ...out,
    projectId,
    project: overview?.project,
    tools: overview?.tools,
    docs: overview?.docs,
    bugs: overview?.bugs,
  });
});

/**
 * GET /api/mcp-lab/docs?serverName=&serverUrl=&toolName=&limit=
 */
const listDocs = asyncHandler(async (req, res) => {
  const docs = await mcpDocs.listDocs({
    projectId: req.query.projectId,
    serverName: req.query.serverName,
    serverUrl: req.query.serverUrl,
    toolName: req.query.toolName,
    limit: req.query.limit || 100,
    userId: req.user?._id,
  });
  res.json({ docs });
});

/** GET /api/mcp-lab/docs/:id */
const getDoc = asyncHandler(async (req, res) => {
  const doc = await McpDoc.findById(req.params.id);
  if (!doc) return res.status(404).json({ message: "Not found" });
  res.json({ doc });
});

/** DELETE /api/mcp-lab/docs/:id */
const deleteDoc = asyncHandler(async (req, res) => {
  await McpDoc.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

/**
 * POST /api/mcp-lab/qa/run
 * body: { config, sampleArgsByTool?, maxCasesPerTool?, save? }
 * Generates QA cases, executes tools directly, and returns concrete bugs.
 */
const runQa = asyncHandler(async (req, res) => {
  const { projectId, sampleArgsByTool, maxCasesPerTool, save = true } = req.body;
  if (!projectId) return res.status(400).json({ message: "projectId required" });

  const { config } = await mcpProjects.resolveConfig({
    projectId,
    userId: req.user?._id,
  });

  const out = await mcpQa.runQa({
    config,
    projectId,
    sampleArgsByTool: sampleArgsByTool || {},
    maxCasesPerTool: maxCasesPerTool || 5,
    save,
    userId: req.user?._id,
  });
  res.json(out);
});

/**
 * GET /api/mcp-lab/bugs?projectId=&toolName=&status=
 */
const listBugs = asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.projectId) q.projectId = req.query.projectId;
  if (req.query.toolName) q.toolName = req.query.toolName;
  if (req.query.status) q.status = req.query.status;
  if (req.user?._id) q.userId = req.user._id;
  const bugs = await McpBug.find(q).sort({ createdAt: -1 });
  res.json({ bugs });
});

/**
 * PATCH /api/mcp-lab/bugs/:id/status
 * body: { status: "open"|"ignored"|"fixed" }
 */
const updateBugStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!["open", "ignored", "fixed"].includes(status)) {
    return res.status(400).json({ message: "invalid status" });
  }
  const q = { _id: req.params.id };
  if (req.user?._id) q.userId = req.user._id;
  const bug = await McpBug.findOneAndUpdate(q, { $set: { status } }, { new: true });
  if (!bug) return res.status(404).json({ message: "Not found" });
  res.json({ bug });
});

/**
 * POST /api/mcp-lab/compare/:traceId
 * body: { apiUrl, apiResponse, provider?, model? }
 */
const compare = asyncHandler(async (req, res) => {
  const { traceId } = req.params;
  const { apiUrl, apiResponse, provider, model } = req.body;
  const trace = await mcpLab.compareWithApi({
    traceId,
    apiUrl,
    apiResponse,
    provider: provider || "openai",
    model,
  });
  res.json({ trace });
});

/**
 * GET /api/mcp-lab/traces?serverName=&limit=
 */
const listTraces = asyncHandler(async (req, res) => {
  const { serverName, limit = 50 } = req.query;
  const q = {};
  if (serverName) q.serverName = serverName;
  const traces = await McpTrace.find(q)
    .sort({ createdAt: -1 })
    .limit(Number(limit));
  res.json({ traces });
});

/** GET /api/mcp-lab/traces/:id */
const getTrace = asyncHandler(async (req, res) => {
  const trace = await McpTrace.findById(req.params.id);
  if (!trace) return res.status(404).json({ message: "Not found" });
  res.json({ trace });
});

/** DELETE /api/mcp-lab/traces/:id */
const deleteTrace = asyncHandler(async (req, res) => {
  await McpTrace.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// ----- Suites (test collections) -----

/** POST /api/mcp-lab/suites  body: {name, description, serverName, serverUrl, transport, cases} */
const createSuite = asyncHandler(async (req, res) => {
  const suite = await McpSuite.create(req.body);
  res.status(201).json({ suite });
});

/** GET /api/mcp-lab/suites */
const listSuites = asyncHandler(async (_req, res) => {
  const suites = await McpSuite.find().sort({ createdAt: -1 });
  res.json({ suites });
});

/** GET /api/mcp-lab/suites/:id */
const getSuite = asyncHandler(async (req, res) => {
  const suite = await McpSuite.findById(req.params.id);
  if (!suite) return res.status(404).json({ message: "Not found" });
  res.json({ suite });
});

/** DELETE /api/mcp-lab/suites/:id */
const deleteSuite = asyncHandler(async (req, res) => {
  await McpSuite.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

/**
 * POST /api/mcp-lab/suites/:id/run
 * body: { provider?, model?, judgeProvider?, judgeModel? }
 * Runs every case in the suite, auto-judges each, returns aggregate.
 */
const runSuite = asyncHandler(async (req, res) => {
  const suite = await McpSuite.findById(req.params.id);
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
      });
      const judged = run.trace
        ? await mcpLab.judgeTrace({
            traceId: run.trace._id,
            provider: judgeProvider,
            model: judgeModel,
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
  listBugs,
  updateBugStatus,
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
