const McpProject = require("../model/McpProjectModel.js");
const McpTool = require("../model/McpToolModel.js");
const McpDoc = require("../model/McpDocModel.js");
const { McpSuite } = require("../model/mcpTraceModel.js");
const mcpLab = require("./mcpLabService.js");
const mcpDocs = require("./mcpDocService.js");
const mcpProjects = require("./mcpProjectService.js");

function flattenValues(value, prefix = "") {
  const out = {};
  if (value === null || value === undefined) {
    out[prefix || "$"] = value;
    return out;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      out[`${prefix}[]`] = [];
      return out;
    }
    value.forEach((item, idx) => {
      Object.assign(out, flattenValues(item, `${prefix}[${idx}]`));
    });
    return out;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) {
      out[prefix || "$"] = {};
      return out;
    }
    for (const key of keys) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      Object.assign(out, flattenValues(value[key], nextPrefix));
    }
    return out;
  }
  out[prefix || "$"] = value;
  return out;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (_) {
      return false;
    }
  }
  return false;
}

function diffResponse(expected, actual) {
  const expectedFlat = flattenValues(expected);
  const actualFlat = flattenValues(actual);
  const diffs = [];

  for (const [path, expectedValue] of Object.entries(expectedFlat)) {
    if (!(path in actualFlat)) {
      diffs.push({ path, kind: "missing", expected: expectedValue, actual: undefined });
      continue;
    }
    const actualValue = actualFlat[path];
    if (!valuesEqual(expectedValue, actualValue)) {
      diffs.push({ path, kind: "changed", expected: expectedValue, actual: actualValue });
    }
  }

  for (const path of Object.keys(actualFlat)) {
    if (!(path in expectedFlat)) {
      diffs.push({ path, kind: "added", expected: undefined, actual: actualFlat[path] });
    }
  }

  return {
    diffs,
    expectedFieldCount: Object.keys(expectedFlat).length,
    actualFieldCount: Object.keys(actualFlat).length,
  };
}

async function generateRegressionSuite({ projectId, userId, companyId }) {
  const projectQuery = { _id: projectId };
  if (companyId) projectQuery.companyId = companyId;
  const project = await McpProject.findOne(projectQuery);
  if (!project) throw new Error("MCP project not found");
  const { config } = await mcpProjects.resolveConfig({ projectId, companyId });

  const toolsQuery = { projectId };
  if (companyId) toolsQuery.companyId = companyId;
  const [tools, docs] = await Promise.all([
    McpTool.find(toolsQuery).sort({ name: 1 }),
    McpDoc.find(toolsQuery),
  ]);
  if (!tools.length) throw new Error("Project has no tools to regression-test");

  const docByName = new Map(docs.map((doc) => [doc.toolName, doc]));
  const cases = [];
  const skipped = [];

  for (const tool of tools) {
    const doc = docByName.get(tool.name);
    if (!doc || doc.sampleResponse === undefined || doc.sampleResponse === null) {
      skipped.push({ toolName: tool.name, reason: "no sampleResponse on doc" });
      continue;
    }
    const expectedFieldCount = Object.keys(flattenValues(doc.sampleResponse)).length;
    cases.push({
      name: `${tool.name} regression`,
      expectedTool: tool.name,
      expectedArgs: doc.sampleArgs || {},
      expectedResponse: doc.sampleResponse,
      assertions: [
        `Tool response must match the baseline across ${expectedFieldCount} field(s).`,
      ],
    });
  }

  if (!cases.length) {
    throw new Error(
      "No tools have a verified sampleResponse yet — run the docs generator first."
    );
  }

  const filter = { projectId, kind: "regression" };
  if (companyId) filter.companyId = companyId;

  const suite = await McpSuite.findOneAndUpdate(
    filter,
    {
      $set: {
        name: `${project.projectName} regression`,
        description:
          "Auto-generated regression suite — compares each tool's response against its verified baseline.",
        serverName: config?.name || project.projectName,
        serverUrl: mcpProjects.publicServerUrl(config?.url),
        transport: config?.transport || "http",
        projectId,
        kind: "regression",
        cases,
        generatedBy: { provider: "none", model: null },
        userId,
        companyId,
      },
    },
    { new: true, upsert: true }
  );

  return { suite, skipped };
}

async function runRegressionSuite({ suiteId, userId, companyId }) {
  const filter = { _id: suiteId };
  if (companyId) filter.companyId = companyId;
  const suite = await McpSuite.findOne(filter);
  if (!suite) throw new Error("Regression suite not found");

  const projectQuery = { _id: suite.projectId };
  if (companyId) projectQuery.companyId = companyId;
  const project = await McpProject.findOne(projectQuery);
  if (!project) throw new Error("Regression suite has no project");

  const { config } = await mcpProjects.resolveConfig({
    projectId: suite.projectId,
    companyId,
  });

  const results = [];

  for (const c of suite.cases) {
    const toolName = c.expectedTool;
    const args = c.expectedArgs || {};
    const started = Date.now();
    const run = await mcpLab.invokeTool({
      config,
      toolName,
      args,
      saveTrace: false,
      tags: [`regression:${suite._id}`],
      userId,
      companyId,
    });
    const latencyMs = Date.now() - started;
    const actualResponse = run.toolResponse
      ? mcpDocs.extractToolResponseJson(run.toolResponse)
      : null;

    if (run.status !== "ok" || run.error) {
      results.push({
        caseName: c.name,
        toolName,
        args,
        status: "broken",
        latencyMs,
        error: run.error || "Tool invocation failed",
        expectedResponse: c.expectedResponse,
        actualResponse,
        diffs: [],
        checkedFieldCount: 0,
        changedFieldCount: 0,
      });
      continue;
    }

    const { diffs, expectedFieldCount } = diffResponse(
      c.expectedResponse,
      actualResponse
    );
    const regressionDiffs = diffs.filter((d) => d.kind !== "added");

    results.push({
      caseName: c.name,
      toolName,
      args,
      status: regressionDiffs.length ? "regression" : "ok",
      latencyMs,
      error: null,
      expectedResponse: c.expectedResponse,
      actualResponse,
      diffs,
      checkedFieldCount: expectedFieldCount,
      changedFieldCount: regressionDiffs.length,
    });
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    regression: results.filter((r) => r.status === "regression").length,
    broken: results.filter((r) => r.status === "broken").length,
  };

  return {
    suiteId: suite._id,
    projectId: suite.projectId,
    summary,
    results,
  };
}

module.exports = {
  generateRegressionSuite,
  runRegressionSuite,
  diffResponse,
  flattenValues,
};
