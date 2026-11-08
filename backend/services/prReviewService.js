const Anthropic = require("@anthropic-ai/sdk");
const PrReview = require("../model/PrReviewModel");
const aiUsage = require("./aiUsageService.js");
const { modelFor } = require("./modelRouter.js");
const prDiff = require("./prDiffService");
const businessRules = require("./businessRuleService");
const { resolveDocRunConfig, executeTestCase } = require("./apiQAService");
const { judgeAssertions } = require("./apiSuiteService");
const { getOctokit } = require("./githubService");

// The QA review of a merged pull request, run against the environment the
// watched branch deploys to.
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

const REVIEW_SYSTEM = `You are a senior QA engineer reviewing a merged pull request. Your job is to prove the change works AND to break it.

You receive one endpoint the PR added or changed, what changed, the diff, and the team's approved business rules. Write test cases of these types:
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
async function reviewEndpoint({ doc, change, diffText, companyId, baseUrl, client }) {
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
  if (c.blocked) {
    return {
      type,
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

const VERDICT_LABEL = { pass: "✅ Passes", fail: "❌ Does not pass", review: "⚠️ Needs review" };

/** The comment Olivia leaves on the pull request. */
function commentBody(review) {
  const byType = {};
  for (const t of review.tests.filter((x) => !x.blocked)) {
    const row = (byType[t.type] = byType[t.type] || { passed: 0, failed: 0 });
    t.passed ? row.passed++ : row.failed++;
  }
  let md = `## Olivia QA review: ${VERDICT_LABEL[review.verdict]}\n\n${review.verdictReason}\n\n`;
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
    for (const { doc, change } of changed.slice(0, MAX_ENDPOINTS)) {
      try {
        const { tests, questions } = await reviewEndpoint({
          doc,
          change,
          diffText,
          companyId: watcher.companyId,
          baseUrl,
          client,
        });
        review.tests.push(...tests);
        review.questions.push(...questions);
      } catch (err) {
        // Usually no base URL configured. Recorded, and the verdict says the
        // change wasn't fully checked.
        errors.push(`${doc.method} ${doc.path}: ${err.message}`);
      }
    }

    const { verdict, reason } = verdictFor(review.tests, review.questions, errors);
    review.verdict = verdict;
    review.verdictReason =
      reason +
      (changed.length > MAX_ENDPOINTS
        ? ` Only the first ${MAX_ENDPOINTS} of ${changed.length} changed endpoints were reviewed.`
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
  redactHeaders,
  commentBody,
  MAX_ENDPOINTS,
};
