const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");
const crypto = require("crypto");
const Doc = require("../model/DocModel");
const ApiQaConfig = require("../model/ApiQaConfig");
const ApiProject = require("../model/ApiProject");
const Bug = require("../model/BugModel");
const TestRun = require("../model/TestRunModel");
const SuiteRun = require("../model/SuiteRunModel");
const { decrypt } = require("./secretCrypto");

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "missing",
    });
  }
  return _anthropic;
}

const CLAUDE_MODEL = process.env.CLAUDE_QA_MODEL || "claude-opus-4-7";
const MAX_CASES = parseInt(process.env.QA_MAX_CASES || "15", 10);
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.QA_REQUEST_TIMEOUT_MS || "15000",
  10,
);

// ---------- JSON helpers ----------

function safeParseJson(txt) {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {
    const m = txt.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

// Salvage complete case objects from a (possibly truncated) cases array — so a
// response cut off by max_tokens still yields every case that finished writing.
function salvageCases(raw) {
  if (!raw) return [];
  const start = raw.indexOf('"cases"');
  const arrStart = start === -1 ? -1 : raw.indexOf("[", start);
  if (arrStart === -1) return [];
  const cases = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  for (let i = arrStart + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          cases.push(JSON.parse(raw.slice(objStart, i + 1)));
        } catch (_) {
          /* skip incomplete */
        }
        objStart = -1;
      }
    }
  }
  return cases;
}

// Expand the compact markers the model emits into the real heavy payloads, so
// we test oversized/max-length without bloating the model's JSON output.
function expandMarkers(value) {
  if (typeof value === "string") {
    if (value === "__QA_LONG_STRING__") return "A".repeat(10000);
    if (value === "__QA_OVERSIZED__") return new Array(10000).fill({ x: 1 });
    return value;
  }
  if (Array.isArray(value)) return value.map(expandMarkers);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandMarkers(v);
    return out;
  }
  return value;
}

// ---------- Auth resolution ----------

// Resolve the runtime auth for a run.
// Priority:
//   1. Explicit oauth2_client_credentials auth type
//   2. Auto-detect: variables contain token_url + client_id → fetch OAuth2 token automatically
//   3. Configured bearer/apiKey/basic/custom → use as-is
async function resolveRuntimeAuth(auth, variables) {
  if (auth?.type === "oauth2_client_credentials") {
    const token = await fetchOAuth2Token(variables);
    return { type: "_oauth2_resolved", resolvedToken: token };
  }
  // Auto-detect OAuth2: user added client_id/client_secret/token_url as project variables
  // but didn't change the auth type in the UI — fetch the token anyway.
  if (variables.token_url && variables.client_id) {
    const token = await fetchOAuth2Token(variables);
    return { type: "_oauth2_resolved", resolvedToken: token };
  }
  return auth;
}

function assertAuthConfigured(runtimeAuth) {
  if (!runtimeAuth || runtimeAuth.type === "none") return;
  const headers = buildAuthHeaders(runtimeAuth);
  if (Object.keys(headers).length === 0) {
    const err = new Error(
      `Auth type "${runtimeAuth.type}" is configured but credentials are empty. ` +
      `Open "Target & auth", enter your token or OAuth2 variables (token_url, client_id, client_secret), and save.`
    );
    err.statusCode = 400;
    throw err;
  }
}

function buildAuthHeaders(authConfig) {
  if (!authConfig || authConfig.type === "none") return {};
  const headers = {};
  switch (authConfig.type) {
    case "bearer": {
      const token = decrypt(authConfig.valueEncrypted);
      if (token) headers["Authorization"] = `Bearer ${token}`;
      break;
    }
    case "apiKey":
    case "custom": {
      const name = authConfig.headerName || "X-API-Key";
      const value = decrypt(authConfig.valueEncrypted);
      if (value) headers[name] = value;
      break;
    }
    case "basic": {
      const password = decrypt(authConfig.passwordEncrypted);
      if (authConfig.username) {
        const encoded = Buffer.from(
          `${authConfig.username}:${password}`,
        ).toString("base64");
        headers["Authorization"] = `Basic ${encoded}`;
      }
      break;
    }
    // Runtime-only: token fetched at run time from OAuth2, never stored
    case "_oauth2_resolved": {
      if (authConfig.resolvedToken)
        headers["Authorization"] = `Bearer ${authConfig.resolvedToken}`;
      break;
    }
  }
  return headers;
}

// ---------- OAuth2 client_credentials token fetch ----------

async function fetchOAuth2Token(variables) {
  const tokenUrl = variables.token_url;
  const clientId = variables.client_id;
  const clientSecret = variables.client_secret;
  const scope = variables.scope;
  const grantType = variables.grant_type || "client_credentials";

  if (!tokenUrl || !clientId) {
    const err = new Error(
      "oauth2_client_credentials auth requires token_url and client_id variables. Add them in Target & auth → Variables.",
    );
    err.statusCode = 400;
    throw err;
  }

  const params = new URLSearchParams();
  params.set("grant_type", grantType);
  params.set("client_id", clientId);
  if (clientSecret) params.set("client_secret", clientSecret);
  if (scope) params.set("scope", scope);

  const resp = await axios.post(tokenUrl, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
    validateStatus: () => true,
  });

  if (!resp.data?.access_token) {
    const err = new Error(
      `OAuth2 token fetch failed (${resp.status}): ${JSON.stringify(resp.data)}`,
    );
    err.statusCode = 400;
    throw err;
  }

  console.log(`[QA] OAuth2 token fetched (expires_in: ${resp.data.expires_in}s)`);
  return resp.data.access_token;
}

// ---------- Postman collection builder ----------

function joinUrl(baseUrl, path) {
  const b = String(baseUrl || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

// ---------- Environment variable substitution ----------

// Resolve a project's variables into a plain { key: value } map, decrypting
// any marked secret. Used to fill requests at run time.
function buildVarMap(variables) {
  const map = {};
  for (const v of variables || []) {
    if (!v || !v.key) continue;
    map[v.key] = v.secret ? decrypt(v.value) : v.value;
  }
  return map;
}

// Replace {{key}} tokens anywhere in a string.
function fillTemplate(str, vars) {
  return String(str).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m,
  );
}

// Fill a URL path: {{key}} tokens, plus {param} and :param path segments that
// match a known variable (e.g. /users/{userId} → /users/123).
function fillPath(path, vars) {
  let p = fillTemplate(path, vars);
  p = p.replace(/\{([\w.-]+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  p = p.replace(/:([\w]+)/g, (m, k) => (k in vars ? vars[k] : m));
  return p;
}

function buildPostmanCollection({ doc, config, testCases }) {
  const items = testCases.map((tc) => {
    const url = joinUrl(config.baseUrl, tc.path || doc.path);
    const headerObj = {
      ...(config.defaultHeaders
        ? Object.fromEntries(config.defaultHeaders)
        : {}),
      ...(tc.headers || {}),
    };
    return {
      name: tc.name || `${doc.method} ${doc.path}`,
      request: {
        method: (tc.method || doc.method).toUpperCase(),
        header: Object.entries(headerObj).map(([key, value]) => ({
          key,
          value: String(value),
        })),
        url: { raw: url },
        body: tc.body
          ? {
              mode: "raw",
              raw:
                typeof tc.body === "string" ? tc.body : JSON.stringify(tc.body),
              options: { raw: { language: "json" } },
            }
          : undefined,
      },
    };
  });

  return {
    info: {
      name: `QA · ${doc.method} ${doc.path}`,
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: items,
  };
}

// ---------- Test-case generation via Claude ----------

const TESTGEN_SYSTEM_PROMPT = `You are a senior QA engineer generating a COMPLETE test suite for an HTTP endpoint.
You will receive a JSON spec of one endpoint (method, path, requestBody fields, queryParams, expected responses).

IMPORTANT — REAL DATA FROM DISCOVERY:
If you receive a "REAL DATA FROM DISCOVERY GETs" section, it contains actual IDs and objects fetched live from this API.
You MUST use these real values in your happy_path and realistic cases instead of inventing plausible-looking IDs.
Example: if discovery shows entitlements[0].entitlement.id = 45, use 45 as providerEntitlementId — not a fake number.
Map field names semantically: providerEntitlementId → entitlement.id, requestId → request.id, etc.
For not_found / invalid cases, still use obviously-bogus values (999999, "00000000-0000-0000-0000-000000000000").

Return STRICT JSON only, starting with {, matching this exact shape:
{
  "cases": [
    {
      "name": "Short descriptive name",
      "group": "happy | sad | boundary | security",
      "category": "happy_path | missing_required | wrong_type | malformed_json | not_found | conflict | unauthorized | forbidden | invalid_auth | injection_sql | injection_nosql | injection_xss | injection_command | path_traversal | oversized_payload | empty_string | max_length | min_length | zero | negative | unicode | null_value | extra_fields",
      "method": "POST",
      "path": "/api/example/login",
      "headers": { "Content-Type": "application/json" },
      "body": { "field": "value" },
      "query": { "param": "value" },
      "expectedStatus": [200, 201],
      "rationale": "Why this case matters"
    }
  ]
}

You MUST generate exactly ${MAX_CASES} cases distributed across these 4 GROUPS:

1. HAPPY (1-2 cases) — valid input, expected behavior
   - happy_path: standard valid request
   - happy_path with optional fields included (if any)

2. SAD (3-4 cases) — invalid but plausible inputs
   - missing_required: omit each required field (one case per critical field)
   - wrong_type: send number where string expected (or vice versa)
   - malformed_json: send broken JSON (set body to a raw broken string)
   - not_found / conflict: target a resource that doesn't exist or duplicates one

3. BOUNDARY (3-4 cases) — edges of valid input space
   - empty_string: "" for string fields
   - max_length: for the long string, put the LITERAL marker "__QA_LONG_STRING__" (the runner expands it to 10000 chars). NEVER write the long string out.
   - zero / negative: 0, -1, -99999 for numeric fields
   - unicode: emoji, RTL text, null bytes (\\u0000) in strings
   - null_value: explicit null for fields
   - extra_fields: include fields NOT in the spec (test if API rejects or silently accepts)

4. SECURITY (4-5 cases) — adversarial inputs
   - injection_sql: payloads like "' OR '1'='1", "'; DROP TABLE users--"
   - injection_nosql: payloads like {"$ne": null}, {"$gt": ""}
   - injection_xss: "<script>alert(1)</script>" in string fields
   - injection_command: "; ls -la", "$(whoami)" in fields that might hit a shell
   - path_traversal: "../../etc/passwd" in any path-like field
   - oversized_payload: set body to the LITERAL marker string "__QA_OVERSIZED__" (the runner expands it to a massive array). NEVER write the huge array out.
   - unauthorized: clear auth → set headers to { "Authorization": "" }
   - invalid_auth: send a clearly bogus token → headers: { "Authorization": "Bearer invalid-token-xyz" }

Rules:
- Resolve path params (':id', '{id}') with realistic values (e.g. '123' or a uuid).
- For valid body/query values, match the field 'type' from the spec; only mutate intentionally for sad/boundary/security.
- expectedStatus must reflect a CORRECTLY-implemented API's response:
  - Happy path: [200, 201]
  - Missing required / wrong type / malformed / boundary violations: [400, 422]
  - Unauthorized / invalid_auth: [401, 403]
  - Not found: [404]
  - Conflict: [409]
  - Oversized: [413, 400]
  - Injection attempts: SHOULD be [400, 422] (input rejected) OR [200, 201] (sanitized & treated as plain text). NEVER 500.
- Do not include the auth header for normal cases — the runner adds it. Only set headers explicitly for security cases that need to clear or override auth.
- Body must be a valid JSON object EXCEPT for malformed_json case (use a string).
- COMPACTNESS (critical): keep every value SHORT. Never write a string longer than ~60 chars or an array longer than 3 items. For oversized/max_length use the markers above — the output must stay small or it gets truncated.
- Return ONLY the JSON, no prose.`;

async function generateTestCases(doc, { anthropicClient = null, variables = {}, context = {} } = {}) {
  const spec = {
    method: doc.method,
    path: doc.path,
    description: doc.description,
    requestBody: doc.requestBody,
    queryParams: doc.queryParams,
    responses: doc.responses,
  };

  // Tell the model which environment variables exist so it uses {{key}}
  // placeholders (the runner injects the real values) instead of inventing IDs.
  const varKeys = Object.keys(variables || {});
  const envNote = varKeys.length
    ? `\n\nAVAILABLE ENVIRONMENT VARIABLES: ${varKeys.join(", ")}
Use a "{{key}}" placeholder wherever a path param or field matches one of these (e.g. /users/{{userId}}) so the runner injects the real value. For not_found / invalid cases, use an obviously-bogus literal instead of the placeholder.`
    : "";

  // Real data from discovery GETs — lets Claude use actual IDs instead of
  // invented ones, making happy-path tests accurate.
  const contextNote = buildContextNote(context);

  const client = anthropicClient || getAnthropic();
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    // 16k so 15 detailed cases never get truncated mid-JSON (the old 6k cap
    // silently cut the output → unparseable → zero cases).
    max_tokens: 16000,
    system: TESTGEN_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `ENDPOINT SPEC:\n${JSON.stringify(spec, null, 2)}${envNote}${contextNote}`,
      },
    ],
  });

  const raw = (response.content || []).map((c) => c.text || "").join("");
  const parsed = safeParseJson(raw);
  // If the JSON parsed cleanly use it; otherwise salvage whatever cases did
  // finish writing (handles truncation gracefully instead of returning zero).
  let cases = parsed?.cases || [];
  if (cases.length === 0) {
    cases = salvageCases(raw);
    if (cases.length === 0) {
      console.warn(
        `generateTestCases: 0 cases (stop=${response.stop_reason}, outTokens=${response.usage?.output_tokens}). Raw head: ${raw.slice(0, 200)}`,
      );
    } else {
      console.warn(
        `generateTestCases: salvaged ${cases.length} cases from truncated output (stop=${response.stop_reason}).`,
      );
    }
  }

  return {
    cases: cases.slice(0, MAX_CASES),
    usage: {
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
    },
  };
}

// ---------- Test executor ----------

async function executeTestCase({ testCase, doc, config, variables = {} }) {
  const method = (testCase.method || doc.method).toUpperCase();
  const baseUrl = fillTemplate(config.baseUrl, variables);
  const path = fillPath(testCase.path || doc.path, variables);
  const url = joinUrl(baseUrl, path);

  const defaultHeaders = config.defaultHeaders
    ? Object.fromEntries(config.defaultHeaders)
    : {};
  const authHeaders = buildAuthHeaders(config.auth);

  // Test case headers OVERRIDE defaults — so the unauthorized case can clear auth.
  const tcHeaders = testCase.headers || {};
  const headers = { ...defaultHeaders, ...authHeaders, ...tcHeaders };

  // If the case explicitly set Authorization to "", drop it entirely.
  Object.keys(headers).forEach((k) => {
    if (headers[k] === "" || headers[k] == null) delete headers[k];
    else headers[k] = fillTemplate(headers[k], variables);
  });

  // Fill {{key}} tokens inside the body. Keep `body` COMPACT (markers intact)
  // for the saved record, and build `sendBody` with markers expanded for the
  // real request — so we never store a 10k-item array in the DB.
  let body = testCase.body || null;
  if (body != null && body !== "__QA_OVERSIZED__") {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const filled = fillTemplate(raw, variables);
    body = typeof body === "string" ? filled : safeParseJson(filled) ?? body;
  }
  const sendBody = body != null ? expandMarkers(body) : null;

  const requestRecord = {
    method,
    url,
    headers,
    body,
  };

  const start = Date.now();
  try {
    const axiosResp = await axios({
      method,
      url,
      headers,
      params: testCase.query || undefined,
      data: sendBody || undefined,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true, // we want every status to come through, not throw
      maxRedirects: 0,
    });

    return {
      request: requestRecord,
      response: {
        status: axiosResp.status,
        durationMs: Date.now() - start,
        headers: axiosResp.headers,
        body: axiosResp.data,
        error: null,
      },
    };
  } catch (err) {
    return {
      request: requestRecord,
      response: {
        status: 0,
        durationMs: Date.now() - start,
        headers: {},
        body: null,
        error: err.message || String(err),
      },
    };
  }
}

// ---------- Bug analysis via Claude ----------

const ANALYZE_SYSTEM_PROMPT = `You are a senior QA engineer reviewing the results of running a full test suite (happy / sad / boundary / security) against an HTTP endpoint.

You will receive:
- The endpoint spec (method, path, expected request shape, expected responses).
- An array of executed test cases, each with the request sent, the response received, and the expectedStatus range.

Your job: identify BUGS. A bug is a deviation from correct API behavior. Look for:
- Happy path failures: happy_path returned non-2xx.
- Status mismatch: response.status NOT in expectedStatus.
- Server crashes: 5xx on any sad/boundary/security input (validation should never produce a 500).
- Auth bypass: unauthorized / invalid_auth cases that returned 2xx.
- Information leakage: stack traces, internal file paths, SQL errors, ORM errors, hostname/IP, or tokens leaked in error response bodies.
- Injection vulnerability evidence: SQL injection that returned different data than a normal request, NoSQL operator that bypassed filters, XSS payload reflected un-escaped in the response.
- Boundary mishandling: empty string accepted where required, max_length crashed the server, negative/zero accepted where invalid.
- Schema violations: 2xx responses that don't match the documented response example shape.
- Silent acceptance of garbage: extra_fields / wrong_type returning 2xx when they should have been rejected (only flag if rejection is the correct contract).
- Inconsistent error shapes across cases (one case returns {error}, another returns {message}, another plain text).

Return STRICT JSON only, starting with {, matching this exact shape:
{
  "bugs": [
    {
      "title": "Short title (under 80 chars)",
      "description": "What went wrong and why it matters. Include the actual evidence from the response.",
      "severity": "low | medium | high | critical",
      "category": "status_mismatch | server_error | auth_bypass | info_leak | schema_violation | other",
      "testCaseName": "Name of the test case from the input"
    }
  ]
}

Rules:
- If a case behaves correctly, do NOT add a bug for it. Only flag real problems.
- Severity guide: critical = auth bypass / data leak; high = 500 on validation, secrets in body; medium = wrong status code; low = inconsistent shape.
- Return {"bugs": []} if no bugs found.`;

async function analyzeForBugs({ doc, executions, anthropicClient = null }) {
  const slim = executions.map((ex) => ({
    name: ex.testCase.name,
    category: ex.testCase.category,
    expectedStatus: ex.testCase.expectedStatus,
    rationale: ex.testCase.rationale,
    request: {
      method: ex.result.request.method,
      url: ex.result.request.url,
      hasAuthHeader: Boolean(
        ex.result.request.headers && ex.result.request.headers.Authorization,
      ),
      body: ex.result.request.body,
    },
    response: {
      status: ex.result.response.status,
      durationMs: ex.result.response.durationMs,
      body: truncateForLLM(ex.result.response.body),
      error: ex.result.response.error,
    },
  }));

  const userMsg = `ENDPOINT SPEC:
${JSON.stringify(
  {
    method: doc.method,
    path: doc.path,
    description: doc.description,
    requestBody: doc.requestBody,
    queryParams: doc.queryParams,
    responses: doc.responses,
  },
  null,
  2,
)}

EXECUTED CASES:
${JSON.stringify(slim, null, 2)}`;

  const client = anthropicClient || getAnthropic();
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 12000,
    system: ANALYZE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  const raw = (response.content || []).map((c) => c.text || "").join("");
  const parsed = safeParseJson(raw);
  return {
    bugs: parsed?.bugs || [],
    usage: {
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
    },
  };
}

function truncateForLLM(body) {
  if (body == null) return null;
  const s = typeof body === "string" ? body : JSON.stringify(body);
  if (s.length <= 2000) return body;
  return s.slice(0, 2000) + "…[truncated]";
}

// ---------- Discovery phase (context store) ----------

// Only list-GET endpoints (no path params) are safe to run during discovery.
function isListGet(doc) {
  if (doc.method?.toUpperCase() !== "GET") return false;
  // Skip any path with {param} or :param — those need IDs we don't have yet.
  return !/{[^}]+}/.test(doc.path) && !/(\/:[a-zA-Z])/.test(doc.path);
}

// Run all list-GET endpoints in the project and collect real data.
// Returns { "/path": responseBody, ... }
async function runDiscoveryGets(projectId, companyId, config, variables) {
  const listDocs = await Doc.find({ companyId, projectId }).lean();
  const gets = listDocs.filter(isListGet).slice(0, 8); // max 8 GETs
  const context = {};
  await Promise.all(
    gets.map(async (doc) => {
      try {
        const result = await executeTestCase({
          testCase: { method: "GET", path: doc.path, headers: {}, body: null, query: {} },
          doc,
          config,
          variables,
        });
        if (result.response.status === 200 && result.response.body != null) {
          context[doc.path] = result.response.body;
        }
      } catch (_) {
        // non-fatal — skip failed GETs
      }
    }),
  );
  if (Object.keys(context).length > 0) {
    console.log(`[QA] Discovery: real data from ${Object.keys(context).length} GET(s): ${Object.keys(context).join(", ")}`);
  }
  return context;
}

// Format the context store as a compact note for Claude.
// Keeps max 3 items per endpoint and caps total size to avoid token waste.
function buildContextNote(context) {
  if (!context || Object.keys(context).length === 0) return "";
  const lines = [
    "REAL DATA FROM DISCOVERY GETs — use these IDs/values in happy path and realistic test cases (don't invent IDs when a real one is available here):",
  ];
  for (const [path, body] of Object.entries(context)) {
    const arr = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    if (arr && arr.length > 0) {
      const sample = JSON.stringify(arr.slice(0, 3)).slice(0, 600);
      lines.push(`${path} → ${sample}`);
    } else if (body && typeof body === "object") {
      lines.push(`${path} → ${JSON.stringify(body).slice(0, 400)}`);
    }
  }
  return "\n\n" + lines.join("\n");
}

// ---------- Orchestrator ----------

async function findBugs({ docId, userId, companyId, anthropicClient = null }) {
  const doc = await Doc.findById(docId);
  if (!doc) {
    const err = new Error("Doc not found");
    err.statusCode = 404;
    throw err;
  }
  if (String(doc.companyId) !== String(companyId)) {
    const err = new Error("Not authorized for this doc");
    err.statusCode = 403;
    throw err;
  }

  // Spec-import docs carry their baseUrl + auth on their ApiProject; classic
  // GitHub docs use the per-repo ApiQaConfig. Both expose { baseUrl, auth }.
  let config;
  let variables = {};
  if (doc.projectId) {
    const project = await ApiProject.findOne({
      _id: doc.projectId,
      companyId,
    });
    if (!project || !project.baseUrl) {
      const err = new Error(
        "No base URL set for this API project. Set baseUrl + auth first.",
      );
      err.statusCode = 400;
      throw err;
    }
    variables = buildVarMap(project.variables);
    const runtimeAuth = await resolveRuntimeAuth(project.auth, variables);
    assertAuthConfigured(runtimeAuth);
    config = {
      baseUrl: project.baseUrl,
      auth: runtimeAuth,
      defaultHeaders: null,
    };
  } else {
    config = await ApiQaConfig.findOne({
      companyId,
      owner: doc.owner,
      repo: doc.repo,
    });
    if (!config) {
      const err = new Error(
        `No QA config found for ${doc.owner}/${doc.repo}. Set baseUrl + auth first.`,
      );
      err.statusCode = 400;
      throw err;
    }
  }

  const runId = crypto.randomUUID();

  // 0) Discovery phase — run all list-GETs in the project to build a context
  // store of real IDs/data. These get passed to Claude so happy-path bodies
  // use actual IDs instead of invented ones.
  const context = doc.projectId
    ? await runDiscoveryGets(doc.projectId, companyId, config, variables)
    : {};

  // 1) generate test cases
  const { cases, usage: genUsage } = await generateTestCases(doc, {
    anthropicClient,
    variables,
    context,
  });
  if (cases.length === 0) {
    return { runId, executions: [], bugs: [], usage: { genUsage } };
  }

  // 2) execute each case
  const executions = [];
  for (const testCase of cases) {
    const result = await executeTestCase({ testCase, doc, config, variables });
    executions.push({ testCase, result });
  }

  // 3) analyze for bugs
  const { bugs, usage: analyzeUsage } = await analyzeForBugs({
    doc,
    executions,
    anthropicClient,
  });

  // Map bugs back onto their executions so the UI can render every test
  // (passing or failing) with bug info inline.
  const bugByName = new Map();
  for (const b of bugs) {
    if (b.testCaseName) bugByName.set(b.testCaseName, b);
  }

  const fullExecutions = executions.map((e) => {
    const bug = bugByName.get(e.testCase.name) || null;
    return {
      name: e.testCase.name,
      group: e.testCase.group || null,
      category: e.testCase.category || null,
      rationale: e.testCase.rationale || "",
      expectedStatus: e.testCase.expectedStatus || [],
      request: e.result.request,
      response: e.result.response,
      isBug: Boolean(bug),
      bugTitle: bug?.title || null,
      bugDescription: bug?.description || null,
      bugSeverity: bug?.severity || null,
      bugCategory: bug?.category || null,
    };
  });

  // 4) persist bugs (legacy Bug collection — kept for the bugs-list view)
  if (bugs.length > 0) {
    const docs = bugs.map((b) => {
      const matchingExec =
        executions.find((e) => e.testCase.name === b.testCaseName) ||
        executions[0];
      return {
        userId,
        companyId,
        docId: doc._id,
        owner: doc.owner,
        repo: doc.repo,
        runId,
        severity: b.severity || "medium",
        category: b.category || "general",
        title: b.title,
        description: b.description,
        testCaseName: b.testCaseName || matchingExec.testCase.name,
        expectedStatus: matchingExec.testCase.expectedStatus,
        request: matchingExec.result.request,
        response: matchingExec.result.response,
      };
    });
    await Bug.insertMany(docs);
  }

  // 5) persist the full run so the user can re-open it later
  const savedRun = await TestRun.create({
    userId,
    companyId,
    docId: doc._id,
    owner: doc.owner,
    repo: doc.repo,
    runId,
    totalTests: fullExecutions.length,
    bugCount: bugs.length,
    executions: fullExecutions,
  });

  return {
    runId,
    testRunId: savedRun._id,
    totalTests: fullExecutions.length,
    bugCount: bugs.length,
    executions: fullExecutions,
    usage: { genUsage, analyzeUsage },
    postmanCollection: buildPostmanCollection({
      doc,
      config,
      testCases: cases,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE MODE — multi-endpoint test run grouped by section/tag
// ─────────────────────────────────────────────────────────────────────────────

const SUITE_TESTGEN_SYSTEM_PROMPT = `You are a senior QA engineer generating a test SUITE for a GROUP of related HTTP endpoints in the same API section.

Unlike single-endpoint testing, a suite tests how endpoints INTERACT: state transitions, chained operations, dependency chains, and cross-endpoint consistency.

You will receive an array of endpoint specs from the same section, plus real data already discovered from GET endpoints.

Return STRICT JSON only, starting with {, matching this exact shape:
{
  "cases": [
    {
      "name": "Short descriptive name",
      "group": "happy | sad | boundary | security | chain",
      "category": "happy_path | state_transition | dependency_chain | missing_required | wrong_type | not_found | conflict | unauthorized | injection_sql | injection_xss | oversized_payload | empty_string | negative | extra_fields",
      "stepIndex": 0,
      "targetMethod": "GET",
      "targetPath": "/api/v1/example/resources",
      "headers": {},
      "body": null,
      "query": {},
      "expectedStatus": [200],
      "rationale": "Why this case matters — for chain/state cases explain what prior step it depends on"
    }
  ]
}

AUTH NOTE: The runner pre-fetches auth automatically before executing any test — do NOT add a "fetch token" step. Auth headers are injected into every request. Your job is to test API behavior, not to set up auth.

OAUTH/TOKEN ENDPOINTS: If the section includes a token endpoint (path contains /token, /oauth, /auth/token):
- Use "body": { "grant_type": "client_credentials", "client_id": "{{client_id}}", "client_secret": "{{client_secret}}" }
- Use "headers": { "Content-Type": "application/x-www-form-urlencoded" }
- For the happy path, set "headers": { "Authorization": "" } to override the pre-fetched token (this endpoint doesn't need auth)
- The body must be sent as application/x-www-form-urlencoded, NEVER as JSON

EXECUTION ORDER RULES (assign stepIndex accordingly):
1. List GETs (no path params) — discovery of real IDs
2. POSTs that create resources — use {{step_N_fieldName}} for any IDs needed in the body
3. GETs with path params — verify the created resource using {{step_N_id}}
4. PUT/PATCH mutations — update the created resource
5. State-changing operations (approve, deny, grant, revoke, activate, etc.)
6. Illegal state transitions — e.g. deny an already-denied request (expect 409/422)
7. DELETE or terminal operations — use IDs obtained in earlier steps
8. Validation/security edge cases last

CHAINING — reference prior step response values with {{step_N_fieldName}}:
- {{step_0_id}}          → "id" field from step 0 response body
- {{step_1_data_0_id}}   → data[0].id from step 1 (paginated list)
- {{step_2_requestId}}   → "requestId" from step 2

For path params like :id, {id}, :requestId — replace with the appropriate {{step_N_field}} once a real ID exists from prior steps, or with a discovery-context real ID if available. For not_found cases use "00000000-0000-0000-0000-000000000000" or 999999.

Also set "method" = targetMethod and "path" = targetPath on every case (the runner uses these directly).

WHAT TO COVER (~20 cases total across the suite):
- Full happy-path CRUD chain end-to-end
- After each mutation, a GET to verify the state change persisted
- At least one illegal state transition (e.g. re-granting an already granted item)
- Missing required field on each critical mutation endpoint
- Unauthorized (clear auth) on 2+ different endpoints
- One injection attempt on the most user-facing string field
- One oversized payload (use __QA_OVERSIZED__ marker)

REAL DATA: use IDs from the discovery section instead of inventing them. Invent only for not_found/invalid cases.
COMPACT: never write strings > 60 chars or arrays > 3 items. Use __QA_LONG_STRING__ and __QA_OVERSIZED__ markers.
Return ONLY the JSON, no prose.`;

async function generateSuiteTestCases(docs, { anthropicClient = null, variables = {}, context = {} } = {}) {
  const specs = docs.map((doc) => ({
    method: doc.method,
    path: doc.path,
    description: doc.description,
    requestBody: doc.requestBody,
    queryParams: doc.queryParams,
    responses: doc.responses,
  }));

  const varKeys = Object.keys(variables || {});
  const envNote = varKeys.length
    ? `\n\nAVAILABLE ENVIRONMENT VARIABLES: ${varKeys.join(", ")}\nUse {{key}} placeholders where path params or fields match.`
    : "";

  const contextNote = buildContextNote(context);

  const client = anthropicClient || getAnthropic();
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 20000,
    system: SUITE_TESTGEN_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `SECTION ENDPOINTS (${specs.length} total):\n${JSON.stringify(specs, null, 2)}${envNote}${contextNote}`,
      },
    ],
  });

  const raw = (response.content || []).map((c) => c.text || "").join("");
  const parsed = safeParseJson(raw);
  let cases = parsed?.cases || [];
  if (cases.length === 0) {
    cases = salvageCases(raw);
    if (cases.length === 0) {
      console.warn(`generateSuiteTestCases: 0 cases (stop=${response.stop_reason}). Raw head: ${raw.slice(0, 200)}`);
    }
  }

  // Sort by stepIndex, then re-number gaplessly so execution order is guaranteed.
  cases.sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0));
  cases = cases.map((c, i) => ({ ...c, stepIndex: i, method: c.targetMethod || c.method, path: c.targetPath || c.path }));

  return {
    cases,
    usage: { inputTokens: response.usage?.input_tokens || 0, outputTokens: response.usage?.output_tokens || 0 },
  };
}

// Shallow-extract response body values into {{step_N_field}} variables so
// subsequent test cases can reference real IDs without hardcoding them.
function extractResponseVars(body, stepIndex) {
  const vars = {};
  if (body == null || typeof body !== "object") return vars;
  const pfx = `step_${stepIndex}`;

  function flatten(obj, prefix) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" || typeof v === "number") vars[`${prefix}_${k}`] = String(v);
    }
  }

  flatten(body, pfx);

  if (Array.isArray(body.data)) {
    // paginated: { data: [...] }
    if (body.data[0]) flatten(body.data[0], `${pfx}_data_0`);
  } else if (body.data && typeof body.data === "object") {
    // single resource: { data: {...} }
    flatten(body.data, `${pfx}_data`);
  }

  return vars;
}

// ---------- Suite orchestrator ----------

async function findBugsForSection({ projectId, section, userId, companyId, anthropicClient = null }) {
  const project = await ApiProject.findOne({ _id: projectId, companyId });
  if (!project || !project.baseUrl) {
    const err = new Error("No base URL set for this project. Configure it first.");
    err.statusCode = 400;
    throw err;
  }

  const docs = await Doc.find({ companyId, projectId, section }).lean();
  if (docs.length === 0) {
    const err = new Error(`No endpoints found in section "${section}".`);
    err.statusCode = 404;
    throw err;
  }

  const variables = buildVarMap(project.variables);
  const runtimeAuth = await resolveRuntimeAuth(project.auth, variables);
  assertAuthConfigured(runtimeAuth);
  const config = { baseUrl: project.baseUrl, auth: runtimeAuth, defaultHeaders: null };

  const runId = crypto.randomUUID();

  // 1) Discovery — run all list-GETs in the section to seed the context store.
  const context = await runDiscoveryGets(projectId, companyId, config, variables);

  // 2) Generate the suite — Claude sees all endpoints at once.
  const { cases, usage: genUsage } = await generateSuiteTestCases(docs, {
    anthropicClient,
    variables,
    context,
  });
  if (cases.length === 0) {
    return { runId, section, executions: [], bugs: [], usage: { genUsage } };
  }

  // 3) Execute in step order, accumulating response values for chaining.
  const executions = [];
  let runtimeVars = { ...variables };

  for (const testCase of cases) {
    // Match the doc whose method+path this case targets.
    const matchDoc =
      docs.find(
        (d) =>
          d.method.toUpperCase() === (testCase.targetMethod || "").toUpperCase() &&
          d.path === testCase.targetPath,
      ) || docs[0];

    const result = await executeTestCase({ testCase, doc: matchDoc, config, variables: runtimeVars });

    // Accumulate vars from successful responses for the next steps.
    if (result.response.status >= 200 && result.response.status < 300) {
      Object.assign(runtimeVars, extractResponseVars(result.response.body, testCase.stepIndex));
    }

    executions.push({ testCase, result });
  }

  // 4) Analyze — pass a section-level "doc" so the analyzer sees all endpoints.
  const sectionDoc = {
    method: "SUITE",
    path: section,
    description: `Section "${section}" — ${docs.length} endpoints: ${docs.map((d) => `${d.method} ${d.path}`).join(" | ")}`,
    requestBody: [],
    queryParams: [],
    responses: [],
  };

  const { bugs, usage: analyzeUsage } = await analyzeForBugs({ doc: sectionDoc, executions, anthropicClient });

  // 5) Map bugs onto executions.
  const bugByName = new Map(bugs.map((b) => [b.testCaseName, b]));
  const fullExecutions = executions.map((e) => {
    const bug = bugByName.get(e.testCase.name) || null;
    return {
      name: e.testCase.name,
      group: e.testCase.group || null,
      category: e.testCase.category || null,
      rationale: e.testCase.rationale || "",
      stepIndex: e.testCase.stepIndex,
      targetMethod: e.testCase.targetMethod || null,
      targetPath: e.testCase.targetPath || null,
      expectedStatus: e.testCase.expectedStatus || [],
      request: e.result.request,
      response: e.result.response,
      isBug: Boolean(bug),
      bugTitle: bug?.title || null,
      bugDescription: bug?.description || null,
      bugSeverity: bug?.severity || null,
      bugCategory: bug?.category || null,
    };
  });

  // 6) Persist suite run.
  const savedRun = await SuiteRun.create({
    userId,
    companyId,
    projectId,
    section,
    runId,
    totalTests: fullExecutions.length,
    bugCount: bugs.length,
    executions: fullExecutions,
  });

  return {
    runId,
    suiteRunId: savedRun._id,
    section,
    totalTests: fullExecutions.length,
    bugCount: bugs.length,
    executions: fullExecutions,
    usage: { genUsage, analyzeUsage },
  };
}

module.exports = {
  findBugs,
  findBugsForSection,
  generateTestCases,
  generateSuiteTestCases,
  buildPostmanCollection,
  executeTestCase,
  analyzeForBugs,
  CLAUDE_MODEL,
};
