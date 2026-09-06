const McpProject = require("../model/McpProjectModel.js");
const McpTool = require("../model/McpToolModel.js");
const McpDoc = require("../model/McpDocModel.js");
const { McpSuite } = require("../model/mcpTraceModel.js");
const mcpLab = require("./mcpLabService.js");
const mcpDocs = require("./mcpDocService.js");
const mcpProjects = require("./mcpProjectService.js");
const { callJsonLLM } = require("./mcpQaService.js");

// ---------- Prompts ----------

const REGRESSION_SYSTEM = `You are a regression-test author for MCP servers.
You receive the project's tools and their docs (which may include verified sampleArgs and response schemas).
For EACH tool, produce a small regression suite: several cases that lock in the tool's current behavior so future changes that break it are caught.
Return STRICT JSON:
{
  "cases": [
    {
      "name": string,
      "toolName": string,
      "args": object,
      "covers": string,
      "assertions": string[]
    }
  ]
}

Rules:
- Produce 2-4 cases per tool: at least one happy path, plus meaningful variations (different valid inputs, an edge/boundary input, and an expected-error input when the schema allows it).
- Every case must call an existing toolName and its args must satisfy the inputSchema (required fields, correct types, enum values).
- Prefer the doc's verified sampleArgs for happy paths — they are known to work.
- "covers": ONE short human sentence describing exactly what this case checks, readable by a non-technical user (e.g. "Returns weather for a valid city").
- "assertions": concrete, checkable statements about the response a judge will evaluate. Be specific about shape/types/values/status, e.g.:
  - "response.temperature is a number"
  - "response.city equals the requested city"
  - "returns an error because the city is missing"
  - "HTTP-like status is 400, not 401"
- Keep args realistic and minimal. Do not invent secret IDs, tokens, or production data — use placeholders only when the schema does not constrain a value.`;

const REGRESSION_JUDGE_SYSTEM = `You are an MCP regression judge.
You receive one executed regression case: its "covers" description, the assertions to check, the tool schema, the args sent, the tool status/error, and the parsed response.
Evaluate EACH assertion against the actual response and decide an overall verdict.
Return STRICT JSON:
{
  "verdict": "pass" | "fail" | "warn",
  "assertionResults": [ { "assertion": string, "ok": boolean, "note": string } ],
  "reasoning": string
}

Rules:
- "pass": every assertion holds against the actual response.
- "fail": at least one assertion is clearly violated (this is a regression).
- "warn": the response is ambiguous or the tool errored in a way that makes an assertion impossible to verify.
- Judge only from the provided evidence; do not speculate beyond the response/error.`;

const REGRESSION_REFINE_SYSTEM = `You are editing ONE regression test case for an MCP tool based on a user instruction.
You receive the tool schema, the current case (args, covers, assertions) and a natural-language instruction describing how to change it.

Your job is ADDITIVE by default: the user is almost always asking to ALSO check something, not to throw away what the case already verifies. NEVER drop an existing assertion unless the instruction EXPLICITLY says to remove, replace, or stop checking it.

Return STRICT JSON describing the DELTA to apply:
{
  "name": string,                 // updated, descriptive case name
  "args": object,                 // full args object, valid against the inputSchema
  "assertionsToAdd": string[],    // brand-new assertions to append (may be empty)
  "assertionsToRemove": string[], // ONLY assertions the user explicitly asked to remove/replace — copy them VERBATIM from the current assertions (usually empty)
  "covers": string                // one sentence summarizing what the case checks AFTER the change (existing assertions that stay + the added ones)
}

Rules:
- Keep the same toolName. Keep args valid against the inputSchema.
- Put every new check in "assertionsToAdd". Leave "assertionsToRemove" empty unless the user explicitly said to remove/replace an existing check.
- Entries in "assertionsToRemove" MUST match an existing assertion verbatim so it can be removed reliably.
- Assertions are concrete, checkable statements about the response (shape/types/values/status), e.g. "response.temperature is a number", "HTTP-like status is 400, not 401".
- "covers": ONE short human sentence readable by a non-technical user, describing what the case checks after the change.
- Return only this JSON object.`;

// ---------- Helpers ----------

function toSuiteCase(c) {
  return {
    name: c.name || `${c.toolName} regression`,
    expectedTool: c.toolName,
    expectedArgs: c.args || {},
    covers: c.covers || "",
    assertions: Array.isArray(c.assertions) ? c.assertions : [],
  };
}

// One safe happy-path case per tool when the LLM is unavailable/invalid.
function fallbackRegressionCases({ tools, docByName }) {
  return tools.map((tool) => {
    const doc = docByName.get(tool.name);
    const args =
      doc?.sampleArgs || mcpDocs.sampleArgsFromSchema(tool.inputSchema || {});
    return {
      name: `${tool.name} regression`,
      toolName: tool.name,
      args,
      covers: "Tool responds successfully with its known-good sample arguments.",
      assertions: ["Tool returns a successful response without an error."],
    };
  });
}

function buildLlmInput(tools, docByName) {
  return tools.map((tool) => {
    const doc = docByName.get(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      sampleArgs: doc?.sampleArgs || null,
      responseSchema: doc?.responseSchema || null,
      responseVerified: doc?.responseVerified || false,
      summary: doc?.summary || null,
    };
  });
}

// Guarantee every tool ends up with at least one case.
function ensureAllToolsCovered(cases, tools, docByName) {
  const covered = new Set(cases.map((c) => c.toolName));
  for (const tool of tools) {
    if (covered.has(tool.name)) continue;
    const doc = docByName.get(tool.name);
    cases.push({
      name: `${tool.name} regression`,
      toolName: tool.name,
      args: doc?.sampleArgs || mcpDocs.sampleArgsFromSchema(tool.inputSchema || {}),
      covers: "Tool responds successfully with its known-good sample arguments.",
      assertions: ["Tool returns a successful response without an error."],
    });
  }
  return cases;
}

// ---------- Generate ----------

async function generateRegressionSuite({
  projectId,
  userId,
  companyId,
  provider = "anthropic",
  model,
  anthropicClient = null,
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
  if (!tools.length) throw new Error("Project has no tools to regression-test");

  const docByName = new Map(docs.map((doc) => [doc.toolName, doc]));

  let usedProvider = "none";
  let usedModel = null;
  let cases = null;

  try {
    const { parsed, model: chosenModel } = await callJsonLLM({
      provider,
      model,
      system: REGRESSION_SYSTEM,
      user: JSON.stringify({ tools: buildLlmInput(tools, docByName) }, null, 2),
      maxTokens: 8192,
      anthropicClient,
    });
    const toolNames = new Set(tools.map((tool) => tool.name));
    const generated = Array.isArray(parsed?.cases) ? parsed.cases : [];
    const valid = generated.filter((c) => c.toolName && toolNames.has(c.toolName));
    if (valid.length) {
      cases = ensureAllToolsCovered(valid, tools, docByName);
      usedProvider = provider;
      usedModel = chosenModel;
    }
  } catch (_) {
    /* fall through to fallback */
  }

  if (!cases) {
    cases = fallbackRegressionCases({ tools, docByName });
  }

  const suiteCases = cases.map(toSuiteCase);

  const filter = { projectId, kind: "regression" };
  if (companyId) filter.companyId = companyId;

  const suite = await McpSuite.findOneAndUpdate(
    filter,
    {
      $set: {
        name: `${project.projectName} regression`,
        description:
          "Auto-generated regression suite — locks in each tool's current behavior.",
        serverName: config?.name || project.projectName,
        serverUrl: mcpProjects.publicServerUrl(config?.url),
        transport: config?.transport || "http",
        projectId,
        kind: "regression",
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

// ---------- Refine one case via natural-language instruction ----------

async function refineRegressionCase({
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
  const filter = { _id: suiteId, kind: "regression" };
  if (companyId) filter.companyId = companyId;
  const suite = await McpSuite.findOne(filter);
  if (!suite) throw new Error("Regression suite not found");

  const current = suite.cases.id(caseId);
  if (!current) throw new Error("Case not found in suite");

  // Give the model the tool's schema so refined args stay valid.
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
      covers: current.covers || "",
      assertions: current.assertions || [],
    },
    instruction,
  };

  const { parsed } = await callJsonLLM({
    provider,
    model,
    system: REGRESSION_REFINE_SYSTEM,
    user: JSON.stringify(payload, null, 2),
    maxTokens: 2048,
    anthropicClient,
  });

  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      "Could not refine the case — the model returned no usable output."
    );
  }

  // Additive merge: start from the existing assertions, drop only the ones the
  // user explicitly asked to remove, then append the new ones. This guarantees
  // "add my check" never silently wipes a validation that was already there.
  const norm = (s) => String(s || "").trim().toLowerCase();
  const cleanList = (v) =>
    Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim()) : [];
  const toAdd = cleanList(parsed.assertionsToAdd);
  const toRemove = cleanList(parsed.assertionsToRemove);
  const existing = cleanList(current.assertions);

  const removeSet = new Set(toRemove.map(norm));
  const merged = existing.filter((a) => !removeSet.has(norm(a)));
  const seen = new Set(merged.map(norm));
  for (const a of toAdd) {
    if (!seen.has(norm(a))) {
      merged.push(a);
      seen.add(norm(a));
    }
  }

  // Never let a refine switch tools.
  current.name = parsed.name || current.name;
  current.expectedArgs = parsed.args || current.expectedArgs;
  current.covers = parsed.covers || current.covers;
  // Guard: if a bad response somehow emptied everything, keep the originals.
  current.assertions = merged.length ? merged : existing;

  await suite.save();
  return { suite, case: current };
}

// ---------- Run ----------

async function judgeRegressionCase({
  suiteCase,
  tool,
  execution,
  provider,
  model,
  anthropicClient,
}) {
  // No assertions to judge → success == tool didn't error.
  if (!suiteCase.assertions || suiteCase.assertions.length === 0) {
    const ok = execution.status === "ok" && !execution.error;
    return {
      verdict: ok ? "pass" : "fail",
      assertionResults: [],
      reasoning: ok
        ? "No assertions; tool responded successfully."
        : "No assertions; tool errored.",
    };
  }
  try {
    const { parsed } = await callJsonLLM({
      provider,
      model,
      system: REGRESSION_JUDGE_SYSTEM,
      user: JSON.stringify(
        {
          covers: suiteCase.covers,
          assertions: suiteCase.assertions,
          tool: tool
            ? { name: tool.name, inputSchema: tool.inputSchema }
            : { name: suiteCase.expectedTool },
          execution,
        },
        null,
        2
      ),
      maxTokens: 2048,
      anthropicClient,
    });
    if (parsed?.verdict) return parsed;
  } catch (_) {
    /* fall through */
  }
  // Fallback: if the tool errored, fail; otherwise warn (can't verify).
  const errored = execution.status !== "ok" || !!execution.error;
  return {
    verdict: errored ? "fail" : "warn",
    assertionResults: [],
    reasoning: errored
      ? "Judge unavailable and the tool errored."
      : "Judge unavailable; could not verify assertions.",
  };
}

async function runRegressionSuite({
  suiteId,
  userId,
  companyId,
  provider = "anthropic",
  model,
  anthropicClient = null,
}) {
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

  const toolsQuery = { projectId: suite.projectId };
  if (companyId) toolsQuery.companyId = companyId;
  const tools = await McpTool.find(toolsQuery);
  const toolByName = new Map(tools.map((t) => [t.name, t]));

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
    const parsedResponse = run.toolResponse
      ? mcpDocs.extractToolResponseJson(run.toolResponse)
      : null;
    const execution = {
      status: run.status,
      error: run.error || null,
      response: parsedResponse,
    };

    const judged = await judgeRegressionCase({
      suiteCase: c,
      tool: toolByName.get(toolName),
      execution,
      provider,
      model,
      anthropicClient,
    });

    results.push({
      caseName: c.name,
      toolName,
      args,
      covers: c.covers || null,
      assertions: c.assertions || [],
      status:
        judged.verdict === "pass"
          ? "ok"
          : judged.verdict === "warn"
            ? "warn"
            : "regression",
      verdict: judged.verdict,
      assertionResults: judged.assertionResults || [],
      reasoning: judged.reasoning || null,
      latencyMs,
      error: run.error || null,
      response: parsedResponse,
    });
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    regression: results.filter((r) => r.status === "regression").length,
    warn: results.filter((r) => r.status === "warn").length,
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
  refineRegressionCase,
  runRegressionSuite,
};
