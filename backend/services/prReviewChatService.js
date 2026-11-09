const PrReview = require("../model/PrReviewModel");
const ApiWatcher = require("../model/ApiWatcherModel");
const Doc = require("../model/DocModel");
const aiUsage = require("./aiUsageService.js");
const { modelFor } = require("./modelRouter.js");
const businessRules = require("./businessRuleService");
const { resolveDocRunConfig, executeTestCase } = require("./apiQAService");
const prReview = require("./prReviewService");

// The conversation with the agent inside a PR review.
//
// The team tells it what it couldn't work out alone ("use order 123", "try that
// as an admin", "create it with POST /orders then ship it"); it runs tests
// against the watcher's dev URL and answers with the results. It remembers the
// whole review and this conversation. Anything it wants to keep for the next
// PR (a variable, a business rule) is only proposed: the user applies it.

const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY = 30;
const MAX_DOCS = 80;

const TOOLS = [
  {
    name: "run_test",
    description:
      "Run one HTTP test against the dev environment and record it in the review. Use {{variable}} placeholders for known variables.",
    input_schema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: 'The endpoint it tests, "METHOD /path", from the review' },
        criterion: { type: "integer", description: "Number of the acceptance criterion this test checks, if any" },
        type: { type: "string", enum: ["functional", "business_rule", "boundary", "security", "regression"] },
        name: { type: "string" },
        covers: { type: "string", description: "One sentence: what this proves" },
        method: { type: "string" },
        path: { type: "string" },
        headers: { type: "object" },
        query: { type: "object" },
        body: {},
        expectedStatus: { type: "array", items: { type: "integer" } },
        assertions: { type: "array", items: { type: "string" } },
      },
      required: ["endpoint", "type", "name", "method", "path", "expectedStatus"],
    },
  },
  {
    name: "prepare_data",
    description:
      "Send one HTTP request to set up data a test needs (create an order, cancel it, read the current state), on ANY endpoint of the API. It is not recorded as a test of the PR. Returns the status and the response body.",
    input_schema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "\"METHOD /path\" from the endpoint lists" },
        why: { type: "string", description: "What data this sets up" },
        method: { type: "string" },
        path: { type: "string" },
        headers: { type: "object" },
        query: { type: "object" },
        body: {},
      },
      required: ["endpoint", "method", "path"],
    },
  },
  {
    name: "mark_wrong_data",
    description:
      "A test you ran failed because the data wasn't what you assumed (the user said an order was cancelled and it isn't), not because the PR is wrong. Takes it out of the verdict: it waits for the right data instead.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The exact name of the test you ran" },
        needs: { type: "string", description: "The data it really needs, e.g. an order in cancelled status" },
      },
      required: ["name", "needs"],
    },
  },
  {
    name: "propose_variable",
    description:
      "Propose saving a value as a variable of this repo, so future reviews can use it as {{key}}. The user decides; nothing is saved until they apply it. Never for passwords or tokens.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "camelCase name, e.g. shippedOrderId" },
        value: { type: "string" },
        why: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "propose_rule",
    description:
      "Propose a business rule learned in this conversation, so future reviews check it. The user decides.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["rule", "permission", "state", "invariant", "known_bug"] },
        text: { type: "string" },
        endpoint: { type: "string", description: '"METHOD /path", or "" for the whole API' },
      },
      required: ["kind", "text"],
    },
  },
];

const SYSTEM = `You are the senior QA agent that reviewed this pull request. The user is a developer or QA on the team.

Help them finish validating the ticket: when they give you data, a hint or a case to try, run tests with run_test and report what happened, plainly and briefly. When a test was blocked for missing data and they provide it, re-run it. Tie each test to the acceptance criterion it checks.

When the user gives a value worth reusing (an id, a slug), offer to keep it with propose_variable. When they state how the API should behave, offer it with propose_rule. Never propose secrets.

When a test needs data that doesn't exist yet (a cancelled order), create it yourself with prepare_data on any endpoint of the API, then run the test with run_test. Check the data really is in the state you need before testing (read it): the user can be wrong about it.

A failed test counts against the PR. If one of yours failed because the data wasn't in the state you assumed, not because the PR behaves wrongly, call mark_wrong_data on it, then set up the right data and run it again.

Never invent data. If you still lack something no endpoint can give you, ask for it. Reply in the user's language.`;

function endpointKey(doc) {
  return `${String(doc.method).toUpperCase()} ${doc.path}`;
}

/** What the agent knows about the review, as text. */
function reviewContext(review, docs, variableKeys, rules, otherKeys = []) {
  const lines = [
    `PR #${review.prNumber} "${review.prTitle}" on ${review.owner}/${review.repo} (${review.branch}).`,
    `Verdict: ${review.verdict} — ${review.verdictReason}`,
    "",
    "ACCEPTANCE CRITERIA:",
    ...(review.criteria?.length
      ? review.criteria.map((c, i) => `${i}. [${c.status}] ${c.text}`)
      : ["(the PR states none)"]),
    "",
    "ENDPOINTS OF THIS REVIEW:",
    ...docs.map((d) => `- ${endpointKey(d)}: ${d.description || ""}`),
    "",
    "OTHER ENDPOINTS OF THE API (for prepare_data):",
    ...(otherKeys.length ? otherKeys.map((k) => `- ${k}`) : ["(none)"]),
    "",
    "TESTS SO FAR:",
    ...review.tests.map(
      (t) =>
        `- [${t.blocked ? "BLOCKED" : t.passed ? "PASS" : "FAIL"}] ${t.endpoint} · ${t.type} · ${t.name}: ${t.reason}`
    ),
    "",
    `VARIABLES AVAILABLE: ${variableKeys.join(", ") || "(none)"}`,
  ];
  if (review.questions.length) {
    lines.push("", "OPEN QUESTIONS:", ...review.questions.map((q) => `- ${q.text}${q.answer ? ` → answered: ${q.answer}` : ""}`));
  }
  return lines.join("\n") + businessRules.rulesNote(rules);
}

async function chat({ reviewId, companyId, message, anthropicClient = null }) {
  const review = await PrReview.findOne({ _id: reviewId, companyId });
  if (!review) {
    const err = new Error("Review not found");
    err.statusCode = 404;
    throw err;
  }
  const watcher = review.watcherId
    ? await ApiWatcher.findOne({ _id: review.watcherId, companyId }).lean()
    : null;
  const baseUrl = String(watcher?.reviewBaseUrl || "").trim();

  const reviewed = new Set(review.tests.map((t) => t.endpoint));
  // Every endpoint of the API can be called, so the agent can set up data
  // (create an order, cancel it); the review's own ones lead the context.
  const allDocs = (
    await Doc.find({ companyId, owner: review.owner, repo: review.repo, ...(review.branch ? { branch: review.branch } : {}) })
  ).slice(0, MAX_DOCS);
  const docs = allDocs.filter((d) => reviewed.has(endpointKey(d)));
  const otherKeys = allDocs.filter((d) => !reviewed.has(endpointKey(d))).map(endpointKey);
  const docByKey = new Map(allDocs.map((d) => [endpointKey(d), d]));

  let variableKeys = [];
  const runConfig = new Map();
  for (const d of allDocs) {
    try {
      const { config, variables } = await resolveDocRunConfig(d, companyId, {});
      runConfig.set(endpointKey(d), { config: { ...config, baseUrl }, variables });
      variableKeys = [...new Set([...variableKeys, ...Object.keys(variables || {})])];
    } catch (_) {
      // No QA config for this repo: run_test reports it.
    }
  }
  const rules = docs.length ? await businessRules.rulesFor({ companyId, doc: docs[0] }) : [];

  review.chat.push({ role: "user", text: String(message).slice(0, 4000) });
  const history = review.chat.slice(-MAX_HISTORY).map((m) => ({
    role: m.role === "agent" ? "assistant" : "user",
    content: m.text || "(no text)",
  }));
  const messages = [
    {
      role: "user",
      content: `REVIEW CONTEXT:\n${reviewContext(review, docs, variableKeys, rules, otherKeys)}`,
    },
    { role: "assistant", content: "Understood. I have the review in front of me." },
    ...history,
  ];

  const client = aiUsage.tag(anthropicClient || prReview.getAnthropic(), {
    action: "pr_review_chat",
    surface: "api",
  });
  const actions = [];
  let reply = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await client.messages.create({
      model: modelFor("bughunt"),
      max_tokens: 4000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    const blocks = resp.content || [];
    reply = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || reply;
    const calls = blocks.filter((b) => b.type === "tool_use");
    if (!calls.length) break;

    messages.push({ role: "assistant", content: blocks });
    const results = [];
    for (const call of calls) {
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: await runTool(call, { review, docByKey, runConfig, baseUrl, client, actions }),
      });
    }
    messages.push({ role: "user", content: results });
  }

  review.chat.push({ role: "agent", text: reply || "Done.", actions });
  const { verdict, reason } = prReview.verdictForReview(review);
  review.verdict = verdict;
  review.verdictReason = reason;
  await review.save();
  return review;
}

async function runTool(call, { review, docByKey, runConfig, baseUrl, client, actions }) {
  const input = call.input || {};
  if (call.name === "run_test") {
    if (!/^https?:\/\//i.test(baseUrl)) {
      return "Can't run: the watcher has no dev URL set.";
    }
    const doc = docByKey.get(input.endpoint);
    const cfg = runConfig.get(input.endpoint);
    if (!doc || !cfg) {
      return `Can't run: ${input.endpoint} is not an endpoint of this API, or the repo has no QA config (auth).`;
    }
    const test = await prReview.runCase({
      c: input,
      doc,
      config: cfg.config,
      variables: cfg.variables,
      client,
      endpoint: input.endpoint,
      source: "chat",
    });
    review.tests.push(test);
    return JSON.stringify({
      passed: test.passed,
      reason: test.reason,
      status: test.response?.status,
      body: test.response?.body,
    }).slice(0, 4000);
  }
  if (call.name === "prepare_data") {
    if (!/^https?:\/\//i.test(baseUrl)) {
      return "Can't run: the watcher has no dev URL set.";
    }
    const doc = docByKey.get(input.endpoint);
    const cfg = runConfig.get(input.endpoint);
    if (!doc || !cfg) {
      return `Can't run: ${input.endpoint} is not an endpoint of this API, or the repo has no QA config (auth).`;
    }
    const ex = await executeTestCase({
      testCase: {
        method: input.method,
        path: input.path,
        headers: input.headers,
        query: input.query && Object.keys(input.query).length ? input.query : undefined,
        body: input.body,
        category: "setup",
      },
      doc,
      config: cfg.config,
      variables: cfg.variables,
    });
    return JSON.stringify({
      status: ex.response.status,
      body: ex.response.body,
      error: ex.response.error || "",
    }).slice(0, 4000);
  }
  if (call.name === "mark_wrong_data") {
    const name = String(input.name || "");
    const test = [...review.tests]
      .reverse()
      .find((t) => t.source === "chat" && t.name === name && !t.passed && !t.blocked);
    if (!test) return `No failed test of yours named "${name}".`;
    const needs = String(input.needs || "the right data").slice(0, 300);
    test.blocked = true;
    test.needs = needs;
    test.reason = `Blocked: needs ${needs} (the data used wasn't in the state assumed)`;
    return "Done: it no longer counts against the PR.";
  }
  if (call.name === "propose_variable") {
    if (/token|secret|password|key/i.test(input.key || "")) {
      return "Not proposed: secrets are configured by the user in the repo's QA settings.";
    }
    actions.push({
      kind: "save_variable",
      key: String(input.key || "").slice(0, 80),
      value: String(input.value ?? "").slice(0, 500),
      why: String(input.why || "").slice(0, 300),
    });
    return "Proposed. The user will see a button to save it.";
  }
  if (call.name === "propose_rule") {
    actions.push({
      kind: "save_rule",
      ruleKind: String(input.kind || "rule"),
      ruleText: String(input.text || "").slice(0, 500),
      endpoint: String(input.endpoint || ""),
    });
    return "Proposed. The user will see a button to save it.";
  }
  return `Unknown tool ${call.name}`;
}

module.exports = { chat };
