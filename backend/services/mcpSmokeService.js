const McpProject = require("../model/McpProjectModel.js");
const McpTool = require("../model/McpToolModel.js");
const McpDoc = require("../model/McpDocModel.js");
const { McpSuite } = require("../model/mcpTraceModel.js");
const mcpLab = require("./mcpLabService.js");
const mcpDocs = require("./mcpDocService.js");
const mcpProjects = require("./mcpProjectService.js");
const { callJsonLLM } = require("./mcpQaService.js");

const SMOKE_SYSTEM = `You are a smoke test author for MCP servers.
You receive the project's tools and their docs (which may already include verified sampleArgs and inferred response schemas).
Produce a smoke suite: ONE happy-path test case per tool that proves the tool is alive and behaves correctly with realistic inputs.
Return STRICT JSON:
{
  "cases": [
    {
      "name": string,
      "toolName": string,
      "args": object,
      "expectedBehavior": string
    }
  ]
}

Rules:
- Exactly one case per tool. Skip no tool.
- If the doc provides a verified sampleArgs, prefer those — they are known to work.
- If sampleArgs are missing or responseVerified is false, build minimal valid args from the inputSchema (cover required fields).
- Args must satisfy the inputSchema (required fields, correct types, enum values when present).
- Keep args realistic and minimal. This is a "is the tool alive?" check, not an edge case.
- expectedBehavior: one short sentence stating success criteria a non-technical user can read.
- Do not invent secret IDs, tokens, or production data. Use placeholders only when the schema does not constrain a value.`;

function fallbackSmokeCases({ tools, docByName }) {
  return tools.map((tool) => {
    const doc = docByName.get(tool.name);
    return {
      name: `${tool.name} smoke`,
      toolName: tool.name,
      args: doc?.sampleArgs || {},
      expectedBehavior: "Tool responds successfully with the verified sample arguments.",
    };
  });
}

async function generateSmokeSuite({ projectId, userId, companyId, provider = "anthropic", model, anthropicClient = null }) {
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
  if (!tools.length) throw new Error("Project has no tools to smoke-test");

  const docByName = new Map(docs.map((doc) => [doc.toolName, doc]));
  const llmInput = tools.map((tool) => {
    const doc = docByName.get(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      sampleArgs: doc?.sampleArgs || null,
      responseVerified: doc?.responseVerified || false,
      summary: doc?.summary || null,
      examples: doc?.examples || [],
    };
  });

  let usedProvider = "none";
  let usedModel = null;
  let cases = null;

  try {
    const { parsed, model: chosenModel } = await callJsonLLM({
      provider,
      model,
      system: SMOKE_SYSTEM,
      user: JSON.stringify({ tools: llmInput }, null, 2),
      maxTokens: 4096,
      anthropicClient,
    });
    const toolNames = new Set(tools.map((tool) => tool.name));
    const generated = Array.isArray(parsed?.cases) ? parsed.cases : [];
    const valid = generated.filter((c) => c.toolName && toolNames.has(c.toolName));
    if (valid.length) {
      const seen = new Set();
      cases = [];
      for (const c of valid) {
        if (seen.has(c.toolName)) continue;
        seen.add(c.toolName);
        cases.push(c);
      }
      for (const tool of tools) {
        if (!seen.has(tool.name)) {
          const doc = docByName.get(tool.name);
          cases.push({
            name: `${tool.name} smoke`,
            toolName: tool.name,
            args: doc?.sampleArgs || {},
            expectedBehavior: "Tool responds successfully with the verified sample arguments.",
          });
        }
      }
      usedProvider = provider;
      usedModel = chosenModel;
    }
  } catch (_) {
    /* fall through to fallback */
  }

  if (!cases) {
    cases = fallbackSmokeCases({ tools, docByName });
  }

  const suiteCases = cases.map((c) => ({
    name: c.name || `${c.toolName} smoke`,
    expectedTool: c.toolName,
    expectedArgs: c.args || {},
    assertions: [c.expectedBehavior || "Tool responds successfully."],
  }));

  const filter = { projectId, kind: "smoke" };
  if (companyId) filter.companyId = companyId;

  const suite = await McpSuite.findOneAndUpdate(
    filter,
    {
      $set: {
        name: `${project.projectName} smoke`,
        description: "Auto-generated smoke suite — one happy path per tool.",
        serverName: config?.name || project.projectName,
        serverUrl: mcpProjects.publicServerUrl(config?.url),
        transport: config?.transport || "http",
        projectId,
        kind: "smoke",
        cases: suiteCases,
        generatedBy: { provider: usedProvider, model: usedModel },
        userId,
        companyId,
      },
    },
    { new: true, upsert: true }
  );

  return { suite, generatedBy: { provider: usedProvider, model: usedModel } };
}

const SMOKE_REFINE_SYSTEM = `You are editing ONE smoke test case for an MCP tool based on a user instruction.
You receive the tool schema, the current case (args, assertions) and a natural-language instruction describing how to change it.
Apply the instruction and return the UPDATED case as STRICT JSON:
{
  "name": string,
  "toolName": string,
  "args": object,
  "expectedBehavior": string
}

Rules:
- Keep the same toolName. Keep args valid against the inputSchema (required fields, correct types, enum values).
- The instruction may ask to use different valid inputs, cover an extra field/id, or restate the success criteria. Apply it faithfully.
- "expectedBehavior": one short sentence a non-technical user can read describing what success looks like.
- This is a smoke ("is the tool alive?") case — keep it a single realistic happy path, not an edge case.
- Return only the single updated case object.`;

// Refine one smoke case from a natural-language instruction. Mirrors the
// regression refiner so both suites feel identical in the UI.
async function refineSmokeCase({
  suiteId,
  caseId,
  instruction,
  userId,
  companyId,
  provider = "anthropic",
  model,
  anthropicClient = null,
}) {
  if (!instruction || !instruction.trim()) {
    throw new Error("An instruction is required to refine a case.");
  }
  const filter = { _id: suiteId, kind: "smoke" };
  if (companyId) filter.companyId = companyId;
  const suite = await McpSuite.findOne(filter);
  if (!suite) throw new Error("Smoke suite not found");

  const current = suite.cases.id(caseId);
  if (!current) throw new Error("Case not found in suite");

  const toolQuery = { projectId: suite.projectId, name: current.expectedTool };
  if (companyId) toolQuery.companyId = companyId;
  const tool = await McpTool.findOne(toolQuery);

  const payload = {
    tool: tool
      ? {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }
      : { name: current.expectedTool },
    currentCase: {
      name: current.name,
      toolName: current.expectedTool,
      args: current.expectedArgs || {},
      expectedBehavior: current.assertions?.[0] || "",
    },
    instruction,
  };

  const { parsed } = await callJsonLLM({
    provider,
    model,
    system: SMOKE_REFINE_SYSTEM,
    user: JSON.stringify(payload, null, 2),
    maxTokens: 2048,
    anthropicClient,
  });

  if (!parsed || !parsed.toolName) {
    throw new Error(
      "Could not refine the case — the model returned no usable output."
    );
  }

  // Never let a refine switch tools.
  current.name = parsed.name || current.name;
  current.expectedArgs = parsed.args || current.expectedArgs;
  if (parsed.expectedBehavior) current.assertions = [parsed.expectedBehavior];

  await suite.save();
  return { suite, case: current };
}

async function runSmokeSuite({ suiteId, userId, companyId }) {
  const filter = { _id: suiteId };
  if (companyId) filter.companyId = companyId;
  const suite = await McpSuite.findOne(filter);
  if (!suite) throw new Error("Smoke suite not found");

  const projectQuery = { _id: suite.projectId };
  if (companyId) projectQuery.companyId = companyId;
  const project = await McpProject.findOne(projectQuery);
  if (!project) throw new Error("Smoke suite has no project");

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
      tags: [`smoke:${suite._id}`],
      userId,
      companyId,
    });
    const ok = run.status === "ok" && !run.error;
    const parsedResponse = run.toolResponse
      ? mcpDocs.extractToolResponseJson(run.toolResponse)
      : null;
    results.push({
      caseName: c.name,
      toolName,
      args,
      expectedBehavior: c.assertions?.[0] || null,
      status: ok ? "ok" : "broken",
      latencyMs: Date.now() - started,
      error: run.error || null,
      response: parsedResponse,
      rawToolResponse: run.toolResponse || null,
      assertions: c.assertions || [],
    });
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
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
  generateSmokeSuite,
  refineSmokeCase,
  runSmokeSuite,
};
