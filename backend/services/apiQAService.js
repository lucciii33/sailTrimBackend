const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");
const crypto = require("crypto");
const Doc = require("../model/DocModel");
const ApiQaConfig = require("../model/ApiQaConfig");
const Bug = require("../model/BugModel");
const TestRun = require("../model/TestRunModel");
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
  10
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

// ---------- Auth resolution ----------

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
          `${authConfig.username}:${password}`
        ).toString("base64");
        headers["Authorization"] = `Basic ${encoded}`;
      }
      break;
    }
  }
  return headers;
}

// ---------- Postman collection builder ----------

function joinUrl(baseUrl, path) {
  const b = String(baseUrl || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

function buildPostmanCollection({ doc, config, testCases }) {
  const items = testCases.map((tc) => {
    const url = joinUrl(config.baseUrl, tc.path || doc.path);
    const headerObj = {
      ...(config.defaultHeaders ? Object.fromEntries(config.defaultHeaders) : {}),
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
   - max_length: very long strings (e.g. 10000 chars) for text fields
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
   - oversized_payload: massive body (e.g. array of 10k items)
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
- Return ONLY the JSON, no prose.`;

async function generateTestCases(doc) {
  const spec = {
    method: doc.method,
    path: doc.path,
    description: doc.description,
    requestBody: doc.requestBody,
    queryParams: doc.queryParams,
    responses: doc.responses,
  };

  const response = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 6000,
    system: TESTGEN_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `ENDPOINT SPEC:\n${JSON.stringify(spec, null, 2)}`,
      },
    ],
  });

  const raw = (response.content || []).map((c) => c.text || "").join("");
  const parsed = safeParseJson(raw);
  const cases = parsed?.cases || [];

  return {
    cases: cases.slice(0, MAX_CASES),
    usage: {
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
    },
  };
}

// ---------- Test executor ----------

async function executeTestCase({ testCase, doc, config }) {
  const method = (testCase.method || doc.method).toUpperCase();
  const baseUrl = config.baseUrl;
  const path = testCase.path || doc.path;
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
  });

  const requestRecord = {
    method,
    url,
    headers,
    body: testCase.body || null,
  };

  const start = Date.now();
  try {
    const axiosResp = await axios({
      method,
      url,
      headers,
      params: testCase.query || undefined,
      data: testCase.body || undefined,
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

async function analyzeForBugs({ doc, executions }) {
  const slim = executions.map((ex) => ({
    name: ex.testCase.name,
    category: ex.testCase.category,
    expectedStatus: ex.testCase.expectedStatus,
    rationale: ex.testCase.rationale,
    request: {
      method: ex.result.request.method,
      url: ex.result.request.url,
      hasAuthHeader: Boolean(
        ex.result.request.headers && ex.result.request.headers.Authorization
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
  2
)}

EXECUTED CASES:
${JSON.stringify(slim, null, 2)}`;

  const response = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 6000,
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

// ---------- Orchestrator ----------

async function findBugs({ docId, userId, companyId }) {
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

  const config = await ApiQaConfig.findOne({
    companyId,
    owner: doc.owner,
    repo: doc.repo,
  });
  if (!config) {
    const err = new Error(
      `No QA config found for ${doc.owner}/${doc.repo}. Set baseUrl + auth first.`
    );
    err.statusCode = 400;
    throw err;
  }

  const runId = crypto.randomUUID();

  // 1) generate test cases
  const { cases, usage: genUsage } = await generateTestCases(doc);
  if (cases.length === 0) {
    return { runId, executions: [], bugs: [], usage: { genUsage } };
  }

  // 2) execute each case
  const executions = [];
  for (const testCase of cases) {
    const result = await executeTestCase({ testCase, doc, config });
    executions.push({ testCase, result });
  }

  // 3) analyze for bugs
  const { bugs, usage: analyzeUsage } = await analyzeForBugs({
    doc,
    executions,
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

module.exports = {
  findBugs,
  generateTestCases,
  buildPostmanCollection,
  executeTestCase,
  analyzeForBugs,
  CLAUDE_MODEL,
};
