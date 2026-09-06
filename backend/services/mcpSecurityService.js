/**
 * MCP Security Scanner
 * ----------------------
 * Runs a catalog of MCP-specific and classic web probes against every tool of
 * a project and persists findings. Findings that look like real vulnerabilities
 * are also stored as McpBug entries so they show up in the existing bug board.
 *
 * Categories covered:
 *   - tool_poisoning      (static scan of the tool description / name)
 *   - prompt_injection    (tool response carries instructions for the LLM)
 *   - secret_leakage      (tool response leaks api keys, tokens, emails, …)
 *   - sql_injection / nosql_injection / command_injection / path_traversal
 *   - ssrf                (url-shaped fields → internal targets)
 *   - xss
 *   - auth_bypass         (re-invoke without credentials)
 *   - schema_bypass       (extra fields / wrong-typed payloads accepted as ok)
 *   - unbounded_response  (empty filters return huge payloads)
 */

const McpProject = require("../model/McpProjectModel.js");
const McpTool = require("../model/McpToolModel.js");
const McpDoc = require("../model/McpDocModel.js");
const McpSecurityRun = require("../model/McpSecurityRunModel.js");
const McpBug = require("../model/McpBugModel.js");
const mcpLab = require("./mcpLabService.js");
const mcpDocs = require("./mcpDocService.js");
const mcpProjects = require("./mcpProjectService.js");

// -------------------------------------------------------------
// Static helpers
// -------------------------------------------------------------

const POISONING_PATTERNS = [
  /ignore (all )?previous (instructions|messages)/i,
  /disregard (the )?system prompt/i,
  /<\s*system\s*>/i,
  /act as (an?|the) /i,
  /exfiltrate|leak|reveal (the )?(api[- ]?key|secret|token)/i,
  /you must (always|never)/i,
];

const SECRET_PATTERNS = [
  { name: "openai_key", re: /sk-[A-Za-z0-9]{20,}/g },
  { name: "anthropic_key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "aws_access_key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "github_token", re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: "stripe_key", re: /sk_(live|test)_[A-Za-z0-9]{16,}/g },
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "bearer_header", re: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: "private_key", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

const PROMPT_INJECTION_RESPONSE_PATTERNS = [
  /ignore (all )?previous (instructions|messages|context)/i,
  /system:\s*you are/i,
  /\b(do not|don'?t) (tell|inform) the user/i,
  /<\/?(system|assistant|tool_use)>/i,
];

function stringify(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function schemaType(schema = {}) {
  if (Array.isArray(schema.type)) return schema.type[0];
  if (schema.type) return schema.type;
  if (schema.enum) return "string";
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "string";
}

function fieldHints(name = "", schema = {}) {
  const lower = name.toLowerCase();
  const format = (schema.format || "").toLowerCase();
  const hints = new Set();
  if (/url|uri|endpoint|callback|webhook|host/.test(lower) || /uri|url/.test(format)) hints.add("url");
  if (/path|file|filename|filepath|dir|directory/.test(lower)) hints.add("path");
  if (/cmd|command|exec|script|shell/.test(lower)) hints.add("command");
  if (/query|sql|where|filter/.test(lower)) hints.add("query");
  if (/id|uuid|token|key|secret/.test(lower)) hints.add("identifier");
  if (/email|mail/.test(lower)) hints.add("email");
  if (/limit|max|count|size|page/.test(lower)) hints.add("limit");
  return hints;
}

function clonePlain(obj) {
  return obj && typeof obj === "object" ? JSON.parse(JSON.stringify(obj)) : obj;
}

function setField(args, field, value) {
  const next = clonePlain(args) || {};
  next[field] = value;
  return next;
}

function findRequiredStringField(tool, baseArgs) {
  const props = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  for (const [name, schema] of Object.entries(props)) {
    const t = schemaType(schema);
    if (t === "string" && (required.has(name) || baseArgs[name] !== undefined)) {
      return { name, schema };
    }
  }
  for (const [name, schema] of Object.entries(props)) {
    if (schemaType(schema) === "string") return { name, schema };
  }
  return null;
}

// -------------------------------------------------------------
// Probes
// -------------------------------------------------------------

function toolPoisoningProbe({ tool }) {
  const text = `${tool.name || ""}\n${tool.description || ""}`;
  const matches = POISONING_PATTERNS.filter((re) => re.test(text));
  if (!matches.length) return null;
  return {
    probe: "tool_poisoning_static",
    category: "tool_poisoning",
    severity: "high",
    title: `Tool description contains prompt-injection patterns`,
    description:
      "The tool's own name or description embeds instructions that could hijack any LLM that loads this tool list.",
    field: "description",
    payload: null,
    args: null,
    response: null,
    evidence: matches.map((m) => m.toString()).join(", "),
    recommendation:
      "Rewrite the tool description as pure capability text. Do not embed imperative instructions, role declarations, or angle-bracket tags.",
  };
}

function scanResponseForSecrets({ response }) {
  const text = stringify(response);
  if (!text) return [];
  const hits = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const matches = text.match(re);
    if (matches?.length) {
      hits.push({ name, sample: matches[0].slice(0, 40) + "…" });
    }
  }
  return hits;
}

function scanResponseForPromptInjection({ response }) {
  const text = stringify(response);
  if (!text) return [];
  return PROMPT_INJECTION_RESPONSE_PATTERNS.filter((re) => re.test(text)).map((re) => re.toString());
}

async function execProbe({ config, tool, args, userId, companyId }) {
  const started = Date.now();
  const run = await mcpLab.invokeTool({
    config,
    toolName: tool.name,
    args,
    saveTrace: false,
    tags: ["mcp-security"],
    userId,
    companyId,
  });
  return {
    status: run.status,
    error: run.error,
    latencyMs: Date.now() - started,
    rawToolResponse: run.toolResponse,
    response: run.toolResponse ? mcpDocs.extractToolResponseJson(run.toolResponse) : null,
  };
}

async function injectionProbe({ config, tool, baseArgs, kind, payload, expectedRejection, userId, companyId }) {
  const target = findRequiredStringField(tool, baseArgs);
  if (!target) return null;
  const args = setField(baseArgs, target.name, payload);
  const exec = await execProbe({ config, tool, args, userId, companyId });

  const looksAccepted = exec.status === "ok" && !exec.error;
  if (!looksAccepted) {
    return null; // tool rejected — that is the desired behavior
  }

  const responseText = stringify(exec.response);
  const echoesPayload = responseText.includes(String(payload).slice(0, 12));

  const categoryMap = {
    sql: { category: "sql_injection", severity: "high", label: "SQL injection" },
    nosql: { category: "nosql_injection", severity: "high", label: "NoSQL injection" },
    command: { category: "command_injection", severity: "critical", label: "Command injection" },
    path: { category: "path_traversal", severity: "high", label: "Path traversal" },
    ssrf: { category: "ssrf", severity: "critical", label: "SSRF" },
    xss: { category: "xss", severity: "medium", label: "XSS" },
  };
  const meta = categoryMap[kind];

  return {
    probe: `${kind}_injection`,
    category: meta.category,
    severity: meta.severity,
    title: `${meta.label} payload accepted on ${tool.name}.${target.name}`,
    description: expectedRejection
      ? `Tool returned a success response when ${target.name} contained a ${meta.label.toLowerCase()} payload. The tool should reject or sanitize this input.`
      : `Tool processed a ${meta.label.toLowerCase()} payload without error.`,
    field: target.name,
    payload,
    args,
    response: exec.response,
    evidence: echoesPayload
      ? `Response echoed the payload, indicating it reached the underlying system without sanitization.`
      : `Tool accepted the payload and returned an ok status.`,
    recommendation:
      "Validate and sanitize this argument server-side before passing it to the underlying datastore, shell, or HTTP client.",
  };
}

async function authBypassProbe({ config, tool, baseArgs, userId, companyId }) {
  const looksAuthed =
    config?.bearerToken ||
    config?.apiKey ||
    (config?.headers &&
      Object.keys(config.headers).some((k) => /auth|key|token/i.test(k)));
  if (!looksAuthed) return null;

  const strippedConfig = clonePlain(config);
  delete strippedConfig.bearerToken;
  delete strippedConfig.apiKey;
  if (strippedConfig.headers) {
    strippedConfig.headers = Object.fromEntries(
      Object.entries(strippedConfig.headers).filter(([k]) => !/auth|key|token/i.test(k))
    );
  }

  let exec;
  try {
    exec = await execProbe({ config: strippedConfig, tool, args: baseArgs, userId, companyId });
  } catch (err) {
    return null;
  }

  if (exec.status !== "ok" || exec.error) return null;
  return {
    probe: "auth_bypass",
    category: "auth_bypass",
    severity: "critical",
    title: `${tool.name} responds successfully without credentials`,
    description:
      "Removing the auth header / token still returned a successful response. The MCP server (or upstream API) likely does not enforce authentication for this tool.",
    field: null,
    payload: null,
    args: baseArgs,
    response: exec.response,
    evidence: `Stripped credentials and tool still returned status=ok.`,
    recommendation:
      "Require and verify credentials at the MCP layer. Reject calls when the expected auth header / token is missing.",
  };
}

async function unboundedResponseProbe({ config, tool, baseArgs, userId, companyId }) {
  const limitField = Object.entries(tool.inputSchema?.properties || {}).find(([name]) =>
    /limit|max|count|size|page[_-]?size/i.test(name)
  );
  if (!limitField) return null;
  const [name, schema] = limitField;
  const aggressive = schemaType(schema) === "integer" || schemaType(schema) === "number" ? 100000 : "10000";
  const args = setField(baseArgs, name, aggressive);
  const exec = await execProbe({ config, tool, args, userId, companyId });
  if (exec.status !== "ok" || exec.error) return null;

  const bytes = Buffer.byteLength(stringify(exec.rawToolResponse), "utf8");
  if (bytes < 200_000) return null;

  return {
    probe: "unbounded_response",
    category: "unbounded_response",
    severity: "high",
    title: `${tool.name} accepts a 100k limit and returns ${(bytes / 1024).toFixed(0)}KB`,
    description: `Tool honored an extreme value for "${name}" and returned a response payload of ~${(bytes / 1024).toFixed(0)}KB. This can blow up the LLM context window and cost.`,
    field: name,
    payload: aggressive,
    args,
    response: exec.response,
    evidence: `Response size ${bytes} bytes after sending ${name}=${aggressive}.`,
    recommendation: `Cap "${name}" server-side (e.g., max 100) and paginate large result sets.`,
  };
}

async function schemaBypassProbe({ config, tool, baseArgs, userId, companyId }) {
  const args = setField(baseArgs, "__unexpected_field__", { evil: true, ts: Date.now() });
  const exec = await execProbe({ config, tool, args, userId, companyId });
  if (exec.status !== "ok" || exec.error) return null;
  return {
    probe: "schema_bypass_unknown_field",
    category: "schema_bypass",
    severity: "low",
    title: `${tool.name} accepted an unknown field`,
    description:
      "Tool returned a successful response when an unknown property was added to the arguments. This is not always a bug, but strict schema validation is preferable.",
    field: "__unexpected_field__",
    payload: { evil: true },
    args,
    response: exec.response,
    evidence: "Tool returned ok with unknown property present.",
    recommendation: 'Set "additionalProperties": false in the input schema and reject unknown keys.',
  };
}

function responseScanFindings({ tool, args, exec }) {
  const out = [];
  const secrets = scanResponseForSecrets({ response: exec.rawToolResponse ?? exec.response });
  if (secrets.length) {
    out.push({
      probe: "response_secret_scan",
      category: "secret_leakage",
      severity: "critical",
      title: `${tool.name} response contains a credential-like string`,
      description: `Detected ${secrets.length} secret-pattern match(es) in the tool response: ${secrets.map((s) => s.name).join(", ")}.`,
      field: null,
      payload: null,
      args,
      response: exec.response,
      evidence: secrets.map((s) => `${s.name}: ${s.sample}`).join(" | "),
      recommendation:
        "Redact tokens, API keys, JWTs and private keys before returning data from the MCP server.",
    });
  }
  const promptInjection = scanResponseForPromptInjection({
    response: exec.rawToolResponse ?? exec.response,
  });
  if (promptInjection.length) {
    out.push({
      probe: "response_prompt_injection_scan",
      category: "prompt_injection",
      severity: "high",
      title: `${tool.name} response contains LLM-directed instructions`,
      description:
        "The tool returned text that looks like an instruction to the LLM (e.g. 'ignore previous instructions'). Whatever data source feeds this tool can hijack the agent.",
      field: null,
      payload: null,
      args,
      response: exec.response,
      evidence: `Matched patterns: ${promptInjection.join(", ")}`,
      recommendation:
        "Treat upstream content as untrusted. Escape or wrap it in clearly-delimited blocks before passing it back to the model.",
    });
  }
  return out;
}

function resolveSampleArgs({ tool, doc }) {
  if (doc?.sampleArgs && typeof doc.sampleArgs === "object") return doc.sampleArgs;
  if (tool.suggestedArgs && typeof tool.suggestedArgs === "object") return tool.suggestedArgs;
  return mcpDocs.sampleArgsFromSchema(tool.inputSchema || {});
}

// -------------------------------------------------------------
// Per-tool scan
// -------------------------------------------------------------

async function scanTool({ config, tool, doc, userId, companyId }) {
  const findings = [];
  const baseArgs = resolveSampleArgs({ tool, doc });

  // 1. Static probe — does not call the server.
  const poison = toolPoisoningProbe({ tool });
  if (poison) findings.push({ ...poison, toolName: tool.name });

  // 2. Baseline call so we can scan the legitimate response for leaks too.
  let baseline = null;
  try {
    baseline = await execProbe({ config, tool, args: baseArgs, userId, companyId });
    if (baseline.status === "ok" && !baseline.error) {
      for (const finding of responseScanFindings({ tool, args: baseArgs, exec: baseline })) {
        findings.push({ ...finding, toolName: tool.name });
      }
    }
  } catch (_) {
    baseline = null;
  }

  // 3. Targeted injection probes.
  const target = findRequiredStringField(tool, baseArgs);
  const hints = target ? fieldHints(target.name, target.schema) : new Set();
  const probes = [];

  const wantsAll = !target || hints.size === 0;
  if (target && (wantsAll || hints.has("query") || hints.has("identifier"))) {
    probes.push({ kind: "sql", payload: "' OR '1'='1'-- ", expectedRejection: true });
    probes.push({ kind: "nosql", payload: '{"$ne": null}', expectedRejection: true });
  }
  if (target && (wantsAll || hints.has("path"))) {
    probes.push({ kind: "path", payload: "../../../../etc/passwd", expectedRejection: true });
  }
  if (target && (wantsAll || hints.has("command"))) {
    probes.push({ kind: "command", payload: "value; id; #", expectedRejection: true });
  }
  if (target && (wantsAll || hints.has("url"))) {
    probes.push({ kind: "ssrf", payload: "http://169.254.169.254/latest/meta-data/", expectedRejection: true });
  }
  if (target && wantsAll) {
    probes.push({ kind: "xss", payload: "<script>alert(1)</script>", expectedRejection: true });
  }

  for (const probe of probes) {
    try {
      const finding = await injectionProbe({
        config,
        tool,
        baseArgs,
        kind: probe.kind,
        payload: probe.payload,
        expectedRejection: probe.expectedRejection,
        userId,
        companyId,
      });
      if (finding) findings.push({ ...finding, toolName: tool.name });
    } catch (_) {
      /* swallow probe-level errors so one bad probe doesn't kill the scan */
    }
  }

  try {
    const f = await authBypassProbe({ config, tool, baseArgs, userId, companyId });
    if (f) findings.push({ ...f, toolName: tool.name });
  } catch (_) {}

  try {
    const f = await unboundedResponseProbe({ config, tool, baseArgs, userId, companyId });
    if (f) findings.push({ ...f, toolName: tool.name });
  } catch (_) {}

  try {
    const f = await schemaBypassProbe({ config, tool, baseArgs, userId, companyId });
    if (f) findings.push({ ...f, toolName: tool.name });
  } catch (_) {}

  return findings;
}

// -------------------------------------------------------------
// Project-level entry point
// -------------------------------------------------------------

function bumpCategoryCount(map, key) {
  map[key] = (map[key] || 0) + 1;
}

async function scanProject({
  projectId,
  save = true,
  userId,
  companyId,
  toolNameFilter = null,
}) {
  const projectQuery = { _id: projectId };
  if (companyId) projectQuery.companyId = companyId;
  const project = await McpProject.findOne(projectQuery);
  if (!project) throw new Error("MCP project not found");

  const { config } = await mcpProjects.resolveConfig({ projectId, companyId });

  const toolsQuery = { projectId };
  if (companyId) toolsQuery.companyId = companyId;
  const [allTools, docs] = await Promise.all([
    McpTool.find(toolsQuery).sort({ name: 1 }),
    McpDoc.find(toolsQuery),
  ]);
  const tools = toolNameFilter
    ? allTools.filter((t) => t.name === toolNameFilter)
    : allTools;
  if (!tools.length) throw new Error("Project has no tools to scan");

  const docByName = new Map(docs.map((d) => [d.toolName, d]));
  const toolByName = new Map(allTools.map((t) => [t.name, t]));

  const findings = [];
  let probesRun = 0;
  for (const tool of tools) {
    const doc = docByName.get(tool.name);
    const toolFindings = await scanTool({
      config,
      tool: { ...tool.toObject(), suggestedArgs: tool.suggestedArgs },
      doc,
      userId,
      companyId,
    });
    probesRun += 1; // one scan invocation per tool, individual probes counted in findings
    findings.push(...toolFindings);
  }

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategory = {};
  for (const f of findings) {
    bumpCategoryCount(bySeverity, f.severity);
    bumpCategoryCount(byCategory, f.category);
  }

  const serverName = config?.name || project.projectName;
  const serverUrl = mcpProjects.publicServerUrl(config?.url);
  const transport = config?.transport || "http";

  const bugIds = [];
  if (save && findings.length) {
    const bugDocs = findings
      .filter((f) => f.severity !== "low") // do not pollute the bug board with low-noise findings
      .map((f) => {
        const toolRecord = toolByName.get(f.toolName);
        const docRecord = docByName.get(f.toolName);
        return {
          projectId,
          toolId: toolRecord?._id,
          docId: docRecord?._id,
          serverName,
          serverUrl,
          transport,
          toolName: f.toolName,
          testCaseName: f.probe,
          severity: f.severity,
          category: `security:${f.category}`,
          title: f.title,
          description: f.description,
          expected: "Tool should reject or safely handle this input.",
          actual: f.evidence,
          evidence: f.evidence,
          recommendation: f.recommendation,
          args: f.args,
          response: f.response,
          status: "open",
          userId,
          companyId,
        };
      });

    if (bugDocs.length) {
      const inserted = await McpBug.insertMany(bugDocs);
      inserted.forEach((bug, idx) => {
        bugIds.push(bug._id);
        // attach bugId back to the matching finding for the response payload
        const findingsAboveLow = findings.filter((x) => x.severity !== "low");
        if (findingsAboveLow[idx]) findingsAboveLow[idx].bugId = bug._id;
      });
    }
  }

  const summary = {
    totalTools: tools.length,
    probesRun,
    findings: findings.length,
    bySeverity,
    byCategory,
  };

  const payload = {
    projectId,
    serverName,
    serverUrl,
    transport,
    summary,
    findings,
    bugIds,
  };

  if (save) {
    const saved = await McpSecurityRun.create({
      ...payload,
      userId,
      companyId,
    });
    payload.runId = saved._id;
  }

  return payload;
}

module.exports = {
  scanProject,
};
