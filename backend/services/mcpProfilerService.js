/**
 * MCP Token Cost Profiler
 * -------------------------
 * For every tool in a project, runs N invocations with realistic sample args,
 * measures latency, response bytes, and estimated input/output tokens, and
 * ranks tools by how much of the model's context window they consume per call.
 *
 * Token estimation uses the well-known ~4 chars/token heuristic. We expose the
 * raw byte/char counts so a caller can swap in a real tokenizer later without
 * touching this surface.
 */

const McpProject = require("../model/McpProjectModel.js");
const McpTool = require("../model/McpToolModel.js");
const McpDoc = require("../model/McpDocModel.js");
const McpProfileRun = require("../model/McpProfileRunModel.js");
const mcpLab = require("./mcpLabService.js");
const mcpDocs = require("./mcpDocService.js");
const mcpProjects = require("./mcpProjectService.js");

const DEFAULT_ITERATIONS = 3;
const DEFAULT_CONTEXT_WINDOW = 200000; // Claude Sonnet 4.x

function approxTokens(value) {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function byteSize(value) {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(text, "utf8");
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedAsc[base + 1] !== undefined) {
    return Math.round(sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base]));
  }
  return sortedAsc[base];
}

function summarizeLatency(samples) {
  if (!samples.length) {
    return { min: 0, p50: 0, p95: 0, max: 0, avg: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  return {
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
  };
}

function summarizeBytes(samples) {
  if (!samples.length) return { min: 0, avg: 0, max: 0 };
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...samples),
    avg: Math.round(sum / samples.length),
    max: Math.max(...samples),
  };
}

function classifyContextRisk(pct) {
  if (pct >= 10) return "critical";
  if (pct >= 5) return "high";
  if (pct >= 1) return "medium";
  return "low";
}

function buildNotes({ contextRiskPct, latency, responseBytes }) {
  const notes = [];
  if (contextRiskPct >= 10) {
    notes.push(
      `Critical: a single call consumes ${contextRiskPct.toFixed(1)}% of the context window. Likely to break long conversations.`
    );
  } else if (contextRiskPct >= 5) {
    notes.push(
      `Heavy: ~${contextRiskPct.toFixed(1)}% of the context per call. Consider pagination or summarization.`
    );
  }
  if (responseBytes.max >= 100_000) {
    notes.push(
      `Response payload reached ${(responseBytes.max / 1024).toFixed(1)} KB. Trim fields or add limits.`
    );
  }
  if (latency.p95 >= 5000) {
    notes.push(`p95 latency is ${latency.p95}ms — slow enough to feel broken inside an agent loop.`);
  }
  return notes;
}

function resolveSampleArgs({ tool, doc, sampleArgsOverride }) {
  if (sampleArgsOverride && typeof sampleArgsOverride === "object") return sampleArgsOverride;
  if (doc?.sampleArgs && typeof doc.sampleArgs === "object") return doc.sampleArgs;
  if (tool.suggestedArgs && typeof tool.suggestedArgs === "object") return tool.suggestedArgs;
  return mcpDocs.sampleArgsFromSchema(tool.inputSchema || {});
}

async function profileTool({ config, tool, args, iterations, userId, companyId }) {
  const latencies = [];
  const outputBytesSamples = [];
  const outputTokenSamples = [];
  let lastResponse = null;
  let lastError = null;
  let okRuns = 0;

  for (let i = 0; i < iterations; i++) {
    const started = Date.now();
    const result = await mcpLab.invokeTool({
      config,
      toolName: tool.name,
      args,
      saveTrace: false,
      tags: ["mcp-profile"],
      userId,
      companyId,
    });
    const elapsed = Date.now() - started;
    latencies.push(elapsed);

    if (result.status !== "ok" || result.error) {
      lastError = result.error || "Tool execution failed";
      continue;
    }

    okRuns += 1;
    const parsed = mcpDocs.extractToolResponseJson(result.toolResponse);
    const bytes = byteSize(result.toolResponse);
    outputBytesSamples.push(bytes);
    outputTokenSamples.push(approxTokens(result.toolResponse));
    lastResponse = parsed;
  }

  if (!okRuns) {
    return {
      toolName: tool.name,
      status: "error",
      error: lastError,
      runs: iterations,
      args,
      latencyMs: summarizeLatency(latencies),
      responseBytes: { min: 0, avg: 0, max: 0 },
      estimatedTokens: { input: approxTokens(args), output: 0, total: approxTokens(args) },
      contextRiskPct: 0,
      contextRiskLevel: "low",
      sampleResponse: null,
      notes: [lastError ? `All ${iterations} runs failed: ${lastError}` : "All runs failed."],
    };
  }

  const latency = summarizeLatency(latencies);
  const responseBytes = summarizeBytes(outputBytesSamples);
  const avgOutputTokens = Math.round(
    outputTokenSamples.reduce((a, b) => a + b, 0) / outputTokenSamples.length
  );
  const inputTokens = approxTokens(args);
  const totalTokens = inputTokens + avgOutputTokens;
  return {
    toolName: tool.name,
    status: "ok",
    runs: iterations,
    args,
    latencyMs: latency,
    responseBytes,
    estimatedTokens: {
      input: inputTokens,
      output: avgOutputTokens,
      total: totalTokens,
    },
    contextRiskPct: 0, // filled later when contextWindow is known
    contextRiskLevel: "low",
    sampleResponse: lastResponse,
    notes: [],
  };
}

async function profileProject({
  projectId,
  iterationsPerTool = DEFAULT_ITERATIONS,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  save = true,
  userId,
  companyId,
}) {
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
  if (!tools.length) throw new Error("Project has no tools to profile");

  const docByName = new Map(docs.map((doc) => [doc.toolName, doc]));

  const toolResults = [];
  for (const tool of tools) {
    const doc = docByName.get(tool.name);
    const args = resolveSampleArgs({ tool, doc });
    const profile = await profileTool({
      config,
      tool: { ...tool.toObject(), suggestedArgs: tool.suggestedArgs },
      args,
      iterations: iterationsPerTool,
      userId,
      companyId,
    });
    if (profile.status === "ok") {
      profile.contextRiskPct = (profile.estimatedTokens.total / contextWindow) * 100;
      profile.contextRiskLevel = classifyContextRisk(profile.contextRiskPct);
      profile.notes = buildNotes({
        contextRiskPct: profile.contextRiskPct,
        latency: profile.latencyMs,
        responseBytes: profile.responseBytes,
      });
    }
    toolResults.push(profile);
  }

  const okResults = toolResults.filter((r) => r.status === "ok");
  const heaviest = okResults.reduce(
    (best, r) => (!best || r.estimatedTokens.total > best.estimatedTokens.total ? r : best),
    null
  );
  const slowest = okResults.reduce(
    (best, r) => (!best || r.latencyMs.p95 > best.latencyMs.p95 ? r : best),
    null
  );
  const totalTokens = okResults.reduce((a, r) => a + r.estimatedTokens.total, 0);
  const contextBombs = okResults.filter((r) => r.contextRiskPct >= 5).length;

  const summary = {
    totalTools: tools.length,
    profiledTools: okResults.length,
    failedTools: toolResults.length - okResults.length,
    totalEstimatedTokens: totalTokens,
    heaviestTool: heaviest?.toolName || null,
    heaviestToolTokens: heaviest?.estimatedTokens.total || 0,
    slowestTool: slowest?.toolName || null,
    slowestToolP95Ms: slowest?.latencyMs.p95 || 0,
    contextBombs,
  };

  const payload = {
    projectId,
    serverName: config?.name || project.projectName,
    serverUrl: mcpProjects.publicServerUrl(config?.url),
    transport: config?.transport || "http",
    contextWindow,
    iterationsPerTool,
    summary,
    tools: toolResults,
  };

  if (save) {
    const saved = await McpProfileRun.create({
      ...payload,
      userId,
      companyId,
    });
    payload.runId = saved._id;
  }

  return payload;
}

module.exports = {
  profileProject,
  approxTokens,
  classifyContextRisk,
};
