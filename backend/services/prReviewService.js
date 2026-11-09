const Anthropic = require("@anthropic-ai/sdk");
const PrReview = require("../model/PrReviewModel");
const aiUsage = require("./aiUsageService.js");
const { modelFor } = require("./modelRouter.js");
const prDiff = require("./prDiffService");
const businessRules = require("./businessRuleService");
const { resolveDocRunConfig, executeTestCase, findBugs } = require("./apiQAService");
const { judgeAssertions } = require("./apiSuiteService");
const { getOctokit } = require("./githubService");

// The QA review of a merged pull request, run against the environment the
// watched branch deploys to.
//
// First it reads what the PR was supposed to do: the acceptance criteria in its
// title and description. Each criterion is checked by tests and gets its own
// result, met or not. A PR is validated against what was asked, not only
// against what its code happens to do.
//
// For every endpoint the PR added or changed, Claude writes tests of each type
// (does it do what the PR says, do the business rules still hold, edges,
// security, regression), they run, and the results become a verdict with the
// evidence behind it. What Claude couldn't decide becomes a question for the
// team; an answer becomes an approved business rule.
//
// Olivia's verdict is advice. The pull request's author or QA decides.

// A merge that touches many endpoints is reviewed on the first ones only, so
// one big refactor can't spend the month's budget.
const MAX_ENDPOINTS = 8;
const MAX_CASES_PER_ENDPOINT = 12;
const MAX_QUESTIONS_PER_ENDPOINT = 3;
const MAX_DIFF_CHARS = 15000;
const MAX_BODY_CHARS = 3000;

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "missing" });
  }
  return aiUsage.meter(_anthropic, { payer: "platform", action: "pr_review", surface: "api" });
}

const CRITERIA_SYSTEM = `You are a senior QA engineer. Read a pull request's title and description and list its ACCEPTANCE CRITERIA: each separate thing the change must do or must not do, as the team would check it before approving the ticket.

Use explicit criteria when the description has them (an "Acceptance criteria" section, a checklist). Otherwise derive them from what the title and description promise. Do not invent requirements the text doesn't state.

For each criterion, list the endpoints it is about, copied exactly from the endpoint list, and say whether it can be checked through the HTTP API ("api") or only by a person ("manual": UI, emails, documentation).

Return STRICT JSON only:
{"criteria":[{"text":"one sentence","endpoints":["METHOD /path"],"testable":"api"}]}
Return {"criteria":[]} if the description states nothing checkable.`;

const ACCEPTANCE_SYSTEM = `You are a senior QA engineer checking a pull request against its ACCEPTANCE CRITERIA, exactly as the ticket describes them.

You receive the numbered criteria, the PR description (which may give real ids, data and the order to run things in), and the specs of the endpoints involved.

For EACH criterion that can be checked through the API, write the ordered HTTP steps that prove it: usually one request, sometimes a few (call the endpoint, then read the resource to check nothing else changed). The checks run one after another in the criteria's order, against the same environment, so a criterion may rely on the state an earlier one left (the PR's "run in this order").

Use the ids and values the PR description gives. Never invent data: if a criterion needs data neither the description nor the variables give, return it with "blocked": true and "needs".

Return STRICT JSON only:
{"checks":[{"criterion":0,"steps":[{"endpoint":"METHOD /path from the spec list","name":"short name","method":"GET","path":"/products/7/availability","query":{},"headers":{},"body":null,"expectedStatus":[200],"assertions":["plain-language check on the response body"]}],"blocked":false,"needs":""}]}

Rules:
- One entry per criterion number, in order. Skip criteria marked [manual].
- "endpoint" is copied exactly from the spec list; "path" is the concrete URL path to call.
- expectedStatus and assertions say exactly what the criterion requires, nothing more.`;

const REVIEW_SYSTEM = `You are a senior QA engineer reviewing a merged pull request. Your job is to prove the change does what the ticket asked AND to break it.

You receive one endpoint the PR added or changed, the PR's ACCEPTANCE CRITERIA, what changed, the diff, and the team's approved business rules.

The acceptance criteria were already checked, in order, before you. Do not repeat them. Those checks may have changed data (an order's status, a product's stock): never assume a resource is in the state the PR description started from. Prefer data you create in the same case; if a case depends on a state you can't guarantee, mark it blocked.

Write cases of these types:
- "functional": the endpoint does what this PR intended.
- "business_rule": each relevant business rule still holds. Try to violate it.
- "boundary": empty, null, missing and extra fields, wrong types, min/max lengths and values, negative numbers, unicode, very long strings.
- "security": no credentials, a bogus token, another user's resource ids (IDOR), privilege escalation, injection in params and body.
- "regression": behaviour that existed before this PR and must keep working.

Then list QUESTIONS for the team: things the expected behaviour depends on that neither the diff nor the rules answer ("Can a member see orders from other members?"). Only real doubts, at most ${MAX_QUESTIONS_PER_ENDPOINT}.

Return STRICT JSON only:
{
  "cases": [{
    "type": "functional|business_rule|boundary|security|regression",
    "name": "short name",
    "covers": "one sentence: what this proves",
    "method": "GET",
    "path": "/path with {{variable}} placeholders where a value is needed",
    "headers": {},
    "query": {},
    "body": null,
    "expectedStatus": [200],
    "assertions": ["plain-language check on the response body"],
    "blocked": false,
    "needs": ""
  }],
  "questions": ["..."]
}

Rules:
- At most ${MAX_CASES_PER_ENDPOINT} cases, at least one of each type that applies.
- NEVER invent data. If a case needs data you don't have (an id of a resource in a specific state, a user with a specific role) and no environment variable provides it and the case can't create it itself, still write the case but add "blocked": true and "needs": "what data is missing, in one sentence", and ask for it in "questions".
- For a "no credentials" case set "headers": {"Authorization": ""} and the runner removes the project's real credentials.
- Use only the environment variables listed; never invent ids when a variable exists.
- expectedStatus lists every status that would be CORRECT, from the spec and the rules.
- Never write destructive cases against data you didn't create in the same case.`;

const CREDENTIAL_HEADER = /auth|token|key|secret|cookie|session|password/i;

/** A copy of the headers that is safe to show in a pull request. */
function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = CREDENTIAL_HEADER.test(k) ? "[redacted]" : v;
  }
  return out;
}

function truncateBody(body) {
  if (body == null) return body;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}… [truncated]` : body;
}

function parseJson(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

/**
 * Olivia's verdict from the results.
 * fail:   a test of any type failed.
 * review: nothing failed, but tests couldn't run, nothing ran, or there are
 *         questions only the team can answer.
 * pass:   tests ran, all passed, nothing left open.
 */
function verdictFor(tests, questions, errors = []) {
  const blocked = tests.filter((t) => t.blocked);
  tests = tests.filter((t) => !t.blocked);
  const failed = tests.filter((t) => t.passed === false && !t.response?.error);
  if (failed.length) {
    return {
      verdict: "fail",
      reason: `${failed.length} of ${tests.length} tests failed.`,
    };
  }
  const unreachable = tests.filter((t) => t.response?.error);
  if (blocked.length) {
    return {
      verdict: "review",
      reason: `${blocked.length} tests are blocked waiting for data; ${tests.length} ran and passed.`,
    };
  }
  if (!tests.length || unreachable.length || errors.length) {
    return {
      verdict: "review",
      reason: !tests.length
        ? "No tests could be run for this change."
        : `${unreachable.length || errors.length} tests or endpoints could not be checked.`,
    };
  }
  if (questions.length) {
    return {
      verdict: "review",
      reason: `All ${tests.length} tests passed, with ${questions.length} open questions for the team.`,
    };
  }
  return { verdict: "pass", reason: `All ${tests.length} tests passed.` };
}

/** Tests and questions for one endpoint, executed. */
async function reviewEndpoint({ doc, change, diffText, criteria = [], companyId, baseUrl, client }) {
  const resolved = await resolveDocRunConfig(doc, companyId, {});
  // Auth and variables from the repo's settings, but always the watcher's URL.
  const config = { ...resolved.config, baseUrl };
  const { variables } = resolved;
  const rules = await businessRules.rulesFor({ companyId, doc });
  const spec = {
    method: doc.method,
    path: doc.path,
    description: doc.description,
    requestBody: doc.requestBody,
    queryParams: doc.queryParams,
    responses: doc.responses,
  };
  const varKeys = Object.keys(variables || {});

  const resp = await client.messages.create({
    model: modelFor("bughunt"),
    max_tokens: 12000,
    system: REVIEW_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `ENDPOINT SPEC:\n${JSON.stringify(spec, null, 2)}\n\n` +
          `ACCEPTANCE CRITERIA OF THIS PR:\n${criteriaNote(criteria, doc)}\n\n` +
          `WHAT THIS PR CHANGED HERE: ${change || "new endpoint"}\n\n` +
          (varKeys.length ? `AVAILABLE ENVIRONMENT VARIABLES: ${varKeys.join(", ")}\n\n` : "") +
          `DIFF:\n${diffText.slice(0, MAX_DIFF_CHARS)}` +
          businessRules.rulesNote(rules),
      },
    ],
  });
  const parsed = parseJson((resp.content || []).map((b) => b.text || "").join("")) || {};
  const cases = (Array.isArray(parsed.cases) ? parsed.cases : []).slice(0, MAX_CASES_PER_ENDPOINT);
  const endpoint = `${String(doc.method).toUpperCase()} ${doc.path}`;

  const tests = [];
  for (const c of cases) {
    tests.push(await runCase({ c, doc, config, variables, client, endpoint }));
  }

  const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
    .slice(0, MAX_QUESTIONS_PER_ENDPOINT)
    .map((q) => ({ text: String(q).slice(0, 500), endpoint }));
  return { tests, questions };
}

/** Runs one case and turns the result into a test record, evidence included. */
async function runCase({ c, doc, config, variables, client, endpoint, source = "review" }) {
  const type = PrReview.TEST_TYPES.includes(c.type) ? c.type : "functional";
  const criterion = Number.isInteger(c.criterion) ? c.criterion : null;
  if (c.blocked) {
    return {
      type,
      criterion,
      endpoint,
      name: c.name || endpoint,
      covers: c.covers || "",
      expectedStatus: [],
      passed: false,
      blocked: true,
      needs: String(c.needs || "data that isn't available").slice(0, 300),
      source,
      reason: `Blocked: needs ${c.needs || "data that isn't available"}`,
    };
  }
  const execution = await executeTestCase({
    testCase: {
      method: c.method,
      path: c.path,
      headers: c.headers,
      query: c.query && Object.keys(c.query).length ? c.query : undefined,
      body: c.body,
      category: c.type === "security" && c.headers?.Authorization === "" ? "unauthorized" : c.type,
    },
    doc,
    config,
    variables,
  });
  const status = execution.response.status;
  const expected = Array.isArray(c.expectedStatus) ? c.expectedStatus.map(Number) : [];
  const statusOk = expected.length ? expected.includes(status) : status >= 200 && status < 300;
  const assertionResults = execution.response.error
    ? []
    : await judgeAssertions({ doc, execution, assertions: c.assertions || [], client });
  const failedAssertion = assertionResults.find((r) => !r.passed);
  const passed = !execution.response.error && statusOk && !failedAssertion;

  return {
    type,
    criterion,
    source,
    endpoint,
    name: c.name || endpoint,
    covers: c.covers || "",
    expectedStatus: expected,
    passed,
    reason: execution.response.error
      ? `Request failed: ${execution.response.error}`
      : !statusOk
        ? `Expected ${expected.join(" or ") || "2xx"}, got ${status}`
        : failedAssertion
          ? failedAssertion.reason || "An assertion didn't hold"
          : "Passed",
    request: {
      method: execution.request.method,
      url: execution.request.url,
      headers: redactHeaders(execution.request.headers),
      body: truncateBody(execution.request.body),
    },
    response: {
      status,
      durationMs: execution.response.durationMs,
      body: truncateBody(execution.response.body),
      error: execution.response.error || "",
    },
  };
}

function endpointKeyOf(doc) {
  return `${String(doc.method).toUpperCase()} ${doc.path}`;
}

/** The criteria as numbered lines, marking the ones about this endpoint. */
function criteriaNote(criteria, doc) {
  if (!criteria.length) return "(the PR states none)";
  const key = doc ? endpointKeyOf(doc) : "";
  return criteria
    .map((c, i) => {
      const here = doc && (!c.endpoints?.length || c.endpoints.includes(key));
      return `${i}. ${c.text}${c.testable === "manual" ? " [manual]" : ""}${here ? " [about this endpoint]" : ""}`;
    })
    .join("\n");
}

/**
 * Turns the general bug hunter into one aimed at this PR: what changed, the
 * diff and the acceptance criteria, with the order to attack those first.
 */
function focusNoteFor({ doc, change, diffText, criteria }) {
  return (
    "\n\nTHIS IS A HUNT ON A PULL REQUEST'S CHANGES, NOT A GENERAL ONE.\n" +
    `WHAT THE PR CHANGED IN THIS ENDPOINT: ${change || "new endpoint"}\n` +
    `ACCEPTANCE CRITERIA OF THE PR:\n${criteriaNote(criteria || [], doc)}\n` +
    `DIFF:\n${String(diffText || "").slice(0, 8000)}\n` +
    "Aim most cases at the behaviour this PR added or changed: its new fields, " +
    "branches, validations, permissions and state transitions. Try to make each " +
    "acceptance criterion fail. Only a few cases on unchanged behaviour."
  );
}

function addQuestion(review, text, endpoint) {
  if (review.questions.some((q) => q.text === text)) return;
  review.questions.push({ text: text.slice(0, 500), endpoint });
}

/**
 * The acceptance criteria, checked first and in order, each with its own steps
 * so every result is tied to its criterion. Returns the tests it ran.
 */
async function checkAcceptance({ review, docByKey, companyId, baseUrl, client }) {
  const api = review.criteria
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.testable !== "manual");
  if (!api.length) return [];

  const keys = [...new Set(api.flatMap(({ c }) => c.endpoints))].filter((k) => docByKey.has(k));
  const specs = keys.map((k) => {
    const d = docByKey.get(k);
    return { endpoint: k, description: d.description, requestBody: d.requestBody, queryParams: d.queryParams, responses: d.responses };
  });

  // Each endpoint's run settings, from the repo's QA config, on the dev URL.
  const run = new Map();
  let varKeys = [];
  for (const k of keys) {
    const resolved = await resolveDocRunConfig(docByKey.get(k), companyId, {});
    run.set(k, { config: { ...resolved.config, baseUrl }, variables: resolved.variables });
    varKeys = [...new Set([...varKeys, ...Object.keys(resolved.variables || {})])];
  }

  const resp = await client.messages.create({
    model: modelFor("bughunt"),
    max_tokens: 12000,
    system: ACCEPTANCE_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `ACCEPTANCE CRITERIA:\n${criteriaNote(review.criteria, null)}\n\n` +
          `PR DESCRIPTION:\n${review.prBody || "(empty)"}\n\n` +
          (varKeys.length ? `AVAILABLE ENVIRONMENT VARIABLES: ${varKeys.join(", ")}\n\n` : "") +
          `ENDPOINT SPECS:\n${JSON.stringify(specs, null, 2)}`,
      },
    ],
  });
  const parsed = parseJson((resp.content || []).map((b) => b.text || "").join("")) || {};
  const byCriterion = new Map(
    (Array.isArray(parsed.checks) ? parsed.checks : []).map((ch) => [ch.criterion, ch])
  );

  const tests = [];
  for (const { c, i } of api) {
    const check = byCriterion.get(i);
    const steps = Array.isArray(check?.steps) ? check.steps : [];
    if (!check || check.blocked || !steps.length) {
      tests.push(
        await runCase({
          c: { type: "functional", criterion: i, name: c.text, blocked: true, needs: check?.needs || "a way to check it through the API" },
          endpoint: c.endpoints[0] || "",
        })
      );
      continue;
    }
    for (const step of steps) {
      const doc = docByKey.get(step.endpoint);
      const cfg = run.get(step.endpoint);
      if (!doc || !cfg) {
        tests.push(
          await runCase({
            c: { type: "functional", criterion: i, name: step.name || c.text, blocked: true, needs: `the spec of ${step.endpoint}` },
            endpoint: step.endpoint || "",
          })
        );
        continue;
      }
      tests.push(
        await runCase({
          c: { ...step, type: "functional", criterion: i, covers: c.text },
          doc,
          config: cfg.config,
          variables: cfg.variables,
          client,
          endpoint: step.endpoint,
        })
      );
    }
  }
  return tests;
}

/** The PR's title and description, straight from GitHub. */
async function fetchPullRequest(installationId, owner, repo, prNumber) {
  const octokit = await getOctokit(installationId);
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: prNumber,
  });
  return { title: data.title || "", body: data.body || "" };
}

/** The acceptance criteria the PR states, each tied to the endpoints it is about. */
async function extractCriteria({ title, body, endpointKeys, client }) {
  if (!title && !body) return [];
  const resp = await client.messages.create({
    model: modelFor("diff"),
    max_tokens: 3000,
    system: CRITERIA_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `PR TITLE: ${title}\n\nPR DESCRIPTION:\n${body || "(empty)"}\n\n` +
          `ENDPOINTS:\n${endpointKeys.join("\n") || "(none)"}`,
      },
    ],
  });
  const parsed = parseJson((resp.content || []).map((b) => b.text || "").join("")) || {};
  const known = new Set(endpointKeys);
  return (Array.isArray(parsed.criteria) ? parsed.criteria : [])
    .slice(0, 15)
    .map((c) => ({
      text: String(c.text || "").slice(0, 500),
      endpoints: (Array.isArray(c.endpoints) ? c.endpoints : []).filter((k) => known.has(k)),
      testable: c.testable === "manual" ? "manual" : "api",
      status: c.testable === "manual" ? "manual" : "untested",
    }))
    .filter((c) => c.text);
}

/** Each criterion's result, from the tests tied to it. */
function criteriaStatus(criteria, tests) {
  return criteria.map((c, i) => {
    if (c.testable === "manual") return "manual";
    const mine = tests.filter((t) => t.criterion === i);
    const ran = mine.filter((t) => !t.blocked && !t.response?.error);
    if (ran.some((t) => !t.passed)) return "not_met";
    if (ran.length) return "met";
    if (mine.some((t) => t.blocked)) return "blocked";
    return "untested";
  });
}

/**
 * The verdict for a whole review. The criteria come first: a PR that doesn't
 * do what its ticket asked fails, however well its endpoints behave.
 */
function verdictForReview(review, errors = []) {
  const criteria = review.criteria || [];
  const statuses = criteriaStatus(criteria, review.tests);
  criteria.forEach((c, i) => {
    c.status = statuses[i];
  });
  const notMet = criteria.filter((c) => c.status === "not_met");
  const serious = (review.bugs || []).filter((b) => ["critical", "high"].includes(b.severity));
  const minor = (review.bugs || []).length - serious.length;
  const open = criteria.filter((c) => ["blocked", "untested", "manual"].includes(c.status));
  const base = verdictFor(review.tests, review.questions.filter((q) => !q.answer), errors);

  if (notMet.length) {
    return {
      verdict: "fail",
      reason: `${notMet.length} of ${criteria.length} acceptance criteria not met. ${base.reason}`,
    };
  }
  if (serious.length) {
    return {
      verdict: "fail",
      reason: `The bug hunter found ${serious.length} critical or high bugs. ${base.reason}`,
    };
  }
  if (base.verdict === "fail") return base;
  if (minor) {
    return {
      verdict: "review",
      reason: `The bug hunter found ${minor} medium or low bugs to look at. ${base.reason}`,
    };
  }
  if (!criteria.length) {
    return {
      verdict: "review",
      reason: `The PR states no acceptance criteria, so it can't be validated against the ticket; only what the code changed was tested. ${base.reason}`,
    };
  }
  if (open.length) {
    return {
      verdict: "review",
      reason: `${criteria.length - open.length} of ${criteria.length} acceptance criteria met; ${open.length} still need data or a person. ${base.reason}`,
    };
  }
  if (base.verdict === "review") return base;
  return { verdict: "pass", reason: `All ${criteria.length} acceptance criteria met. ${base.reason}` };
}

const VERDICT_LABEL = { pass: "✅ Passes", fail: "❌ Does not pass", review: "⚠️ Needs review" };

/** The comment Olivia leaves on the pull request. */
function commentBody(review) {
  const byType = {};
  for (const t of review.tests.filter((x) => !x.blocked)) {
    const row = (byType[t.type] = byType[t.type] || { passed: 0, failed: 0 });
    t.passed ? row.passed++ : row.failed++;
  }
  let md = `## Olivia QA review: ${VERDICT_LABEL[review.verdict]}\n\n${review.verdictReason}\n\n`;
  const marks = { met: "✅", not_met: "❌", blocked: "🚫", untested: "⚪", manual: "👤" };
  if (review.criteria?.length) {
    md += "### Acceptance criteria\n\n";
    for (const c of review.criteria) md += `- ${marks[c.status] || "⚪"} ${c.text}\n`;
    md += "\n";
  }
  md += "| Type | Passed | Failed |\n|---|---|---|\n";
  for (const type of PrReview.TEST_TYPES) {
    if (byType[type]) md += `| ${type} | ${byType[type].passed} | ${byType[type].failed} |\n`;
  }
  const blocked = review.tests.filter((t) => t.blocked);
  if (blocked.length) {
    md += `\n### Blocked, waiting for data (${blocked.length})\n\n`;
    for (const t of blocked.slice(0, 10)) md += `- **${t.endpoint}**, ${t.name}: needs ${t.needs}\n`;
  }
  const failed = review.tests.filter((t) => !t.passed && !t.blocked).slice(0, 10);
  if (failed.length) {
    md += "\n### Failed\n\n";
    for (const t of failed) {
      md += `- **${t.endpoint}**, ${t.name}: ${t.reason}\n`;
    }
  }
  if (review.bugs?.length) {
    md += `\n### Bugs found (${review.bugs.length})\n\n`;
    for (const b of review.bugs.slice(0, 15)) {
      md += `- **${b.severity}** · ${b.endpoint}: ${b.title}\n`;
    }
  }
  if (review.questions.length) {
    md += "\n### Questions for the team\n\n";
    for (const q of review.questions) md += `- ${q.text} (${q.endpoint})\n`;
  }
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  if (base) md += `\n[Full evidence and answers in Olivia](${base}/pr-reviews/${review._id})\n`;
  md += "\n_Olivia's verdict is advice; the decision is yours._";
  return md;
}

/**
 * Review one merged PR. `changed` lists the endpoint docs it added or changed,
 * each with a short description of the change.
 */
async function reviewPullRequest({
  watcher,
  installationId,
  prNumber,
  prTitle = "",
  files,
  changed,
  allDocs = [],
  anthropicClient = null,
}) {
  const review = await PrReview.create({
    companyId: watcher.companyId,
    watcherId: watcher._id,
    owner: watcher.owner,
    repo: watcher.repo,
    branch: watcher.branch || "",
    prNumber,
    prTitle,
  });

  try {
    const baseUrl = String(watcher.reviewBaseUrl || "").trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
      review.verdict = "review";
      review.verdictReason =
        "Not reviewed: set the URL of the environment this branch deploys to " +
        "on the watcher. Olivia never sends these tests to the repo's default URL.";
      review.status = "done";
      await review.save();
      return review;
    }
    const client = aiUsage.tag(anthropicClient || getAnthropic(), {
      action: "pr_review",
      surface: "api",
    });
    const diffText = prDiff.buildDiffText(files || []);
    const errors = [];

    // What the ticket asked for.
    try {
      const pr = await fetchPullRequest(installationId, watcher.owner, watcher.repo, prNumber);
      review.prTitle = pr.title || review.prTitle;
      review.prBody = pr.body.slice(0, 20000);
    } catch (err) {
      errors.push(`couldn't read the PR description: ${err.message}`);
    }
    const docByKey = new Map(allDocs.map((d) => [endpointKeyOf(d), d]));
    review.criteria = await extractCriteria({
      title: review.prTitle,
      body: review.prBody,
      endpointKeys: [...docByKey.keys()],
      client,
    }).catch((err) => {
      errors.push(`couldn't read the acceptance criteria: ${err.message}`);
      return [];
    });

    // The criteria become proposed business rules, for later PRs to keep.
    await businessRules
      .proposeFromCriteria({
        companyId: watcher.companyId,
        scope: { owner: watcher.owner, repo: watcher.repo },
        criteria: review.criteria,
        prNumber,
      })
      .catch((err) => console.error("[pr-review] couldn't propose rules:", err.message));

    // The ticket first: every criterion, in order, before anything else
    // touches the data it depends on.
    try {
      review.tests.push(
        ...(await checkAcceptance({ review, docByKey, companyId: watcher.companyId, baseUrl, client }))
      );
    } catch (err) {
      errors.push(`acceptance checks: ${err.message}`);
      if (/QA config|auth|token/i.test(err.message)) {
        addQuestion(
          review,
          `Olivia can't authenticate against ${watcher.owner}/${watcher.repo}: ${err.message} ` +
            "Set the auth and variables in this repo's API tests settings, then re-run the review.",
          ""
        );
      }
    }

    // The endpoints to review: what the code changed, plus whatever the
    // criteria are about even if the diff didn't flag it.
    const toReview = [...changed];
    const seen = new Set(toReview.map((c) => endpointKeyOf(c.doc)));
    for (const c of review.criteria) {
      for (const key of c.endpoints) {
        if (!seen.has(key) && docByKey.has(key)) {
          seen.add(key);
          toReview.push({ doc: docByKey.get(key), change: "named by an acceptance criterion" });
        }
      }
    }

    for (const { doc, change } of toReview.slice(0, MAX_ENDPOINTS)) {
      try {
        const { tests, questions } = await reviewEndpoint({
          doc,
          change,
          diffText,
          criteria: review.criteria,
          companyId: watcher.companyId,
          baseUrl,
          client,
        });
        review.tests.push(...tests);
        review.questions.push(...questions);
      } catch (err) {
        // Usually the repo has no QA config (auth) yet: asked for, not guessed.
        errors.push(`${doc.method} ${doc.path}: ${err.message}`);
        if (/QA config|auth|token/i.test(err.message)) {
          addQuestion(
            review,
            `Olivia can't authenticate against ${watcher.owner}/${watcher.repo}: ${err.message} ` +
              "Set the auth and variables in this repo's API tests settings, then re-run the review.",
            endpointKeyOf(doc)
          );
        }
        continue;
      }

      // Then try to break it, with the same bug hunter as the API side, on dev.
      try {
        const hunt = await findBugs({
          docId: doc._id,
          userId: watcher.userId,
          companyId: watcher.companyId,
          anthropicClient,
          baseUrl,
          focusNote: focusNoteFor({ doc, change, diffText, criteria: review.criteria }),
        });
        for (const e of hunt.executions || []) {
          if (!e.isBug) continue;
          review.bugs.push({
            endpoint: endpointKeyOf(doc),
            severity: e.bugSeverity || "medium",
            category: e.bugCategory || "",
            title: e.bugTitle || e.name,
            description: e.bugDescription || "",
            testCaseName: e.name,
            request: e.request && { ...e.request, headers: redactHeaders(e.request.headers) },
            response: e.response && {
              status: e.response.status,
              body: truncateBody(e.response.body),
              error: e.response.error || "",
            },
          });
        }
        // Data it needed and couldn't find becomes a question, not a guess.
        for (const w of hunt.warnings || []) {
          if (w.type !== "missing_data") continue;
          addQuestion(
            review,
            `I need a real value for {${(w.params || []).join(", ")}} to test ${endpointKeyOf(doc)}. ` +
              "Tell me one in the chat and I'll offer to save it as a variable.",
            endpointKeyOf(doc)
          );
        }
      } catch (err) {
        errors.push(`bug hunter on ${doc.method} ${doc.path}: ${err.message}`);
      }
    }

    const { verdict, reason } = verdictForReview(review, errors);
    review.verdict = verdict;
    review.verdictReason =
      reason +
      (toReview.length > MAX_ENDPOINTS
        ? ` Only the first ${MAX_ENDPOINTS} of ${toReview.length} endpoints were reviewed.`
        : "") +
      (errors.length ? ` Not checked: ${errors.join("; ")}` : "");
    review.status = "done";
    await review.save();

    try {
      const octokit = await getOctokit(installationId);
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner: watcher.owner, repo: watcher.repo, issue_number: prNumber, body: commentBody(review) }
      );
      review.commentUrl = data?.html_url || "";
      await review.save();
    } catch (err) {
      console.error("[pr-review] could not comment on the PR:", err.message);
    }
    return review;
  } catch (err) {
    review.status = "failed";
    review.error = err.message || String(err);
    await review.save().catch(() => {});
    return review;
  }
}

module.exports = {
  reviewPullRequest,
  runCase,
  getAnthropic,
  verdictFor,
  verdictForReview,
  criteriaStatus,
  extractCriteria,
  checkAcceptance,
  focusNoteFor,
  redactHeaders,
  commentBody,
  MAX_ENDPOINTS,
};
