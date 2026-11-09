const express = require("express");
const request = require("supertest");

const mockRule = { create: jest.fn() };
jest.mock("../model/BusinessRuleModel", () => ({
  KINDS: ["rule", "permission", "state", "invariant", "known_bug"],
  create: (...a) => mockRule.create(...a),
}));
const mockReviews = [];
jest.mock("../model/PrReviewModel", () => ({
  TEST_TYPES: ["functional", "business_rule", "boundary", "security", "regression"],
  findOne: jest.fn(async ({ _id, companyId }) =>
    mockReviews.find((r) => r._id === _id && r.companyId === companyId) || null
  ),
}));

const svc = require("../services/prReviewService");
const c = require("../controllers/prReviewController");
const { errorHandler } = require("../middleware/errorMiddleware");

const COMPANY = "64b000000000000000000001";
const OTHER = "64b000000000000000000002";
const REVIEW_ID = "64b0000000000000000000c1";

const ok = (type = "functional") => ({ type, passed: true, response: { status: 200, error: "" } });
const bad = (type = "security") => ({ type, passed: false, response: { status: 200, error: "" } });
const down = () => ({ type: "functional", passed: false, response: { status: 0, error: "ECONNREFUSED" } });

describe("verdict", () => {
  test("any failed test fails the PR", () => {
    expect(svc.verdictFor([ok(), bad()], []).verdict).toBe("fail");
  });
  test("all passing with nothing open passes", () => {
    expect(svc.verdictFor([ok(), ok("boundary")], []).verdict).toBe("pass");
  });
  test("open questions need a person", () => {
    expect(svc.verdictFor([ok()], [{ text: "?" }]).verdict).toBe("review");
  });
  test("an unreachable server is not a pass and not a bug", () => {
    expect(svc.verdictFor([ok(), down()], []).verdict).toBe("review");
  });
  test("no tests at all is not a pass", () => {
    expect(svc.verdictFor([], []).verdict).toBe("review");
  });
});

test("credentials never reach the evidence", () => {
  const h = svc.redactHeaders({
    Authorization: "Bearer real",
    "X-API-Key": "k",
    Cookie: "s=1",
    "Content-Type": "application/json",
  });
  expect(h).toEqual({
    Authorization: "[redacted]",
    "X-API-Key": "[redacted]",
    Cookie: "[redacted]",
    "Content-Type": "application/json",
  });
});

test("the PR comment shows the verdict, failures and questions", () => {
  process.env.FRONTEND_URL = "https://app.example.com";
  const md = svc.commentBody({
    _id: "r1",
    verdict: "fail",
    verdictReason: "1 of 2 tests failed.",
    tests: [
      { ...ok(), endpoint: "GET /orders", name: "lists orders" },
      { ...bad(), endpoint: "GET /orders/:id", name: "other user's order", reason: "Expected 403 or 404, got 200" },
    ],
    questions: [{ text: "Can a member see other members' orders?", endpoint: "GET /orders" }],
  });
  expect(md).toContain("❌ Does not pass");
  expect(md).toContain("| security | 0 | 1 |");
  expect(md).toContain("Expected 403 or 404, got 200");
  expect(md).toContain("Can a member see other members' orders?");
  expect(md).toContain("https://app.example.com/pr-reviews/r1");
});

describe("answering questions", () => {
  function appFor(companyId) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { _id: "u1", companyId };
      next();
    });
    app.post("/r/:id/questions/:questionId/answer", c.answerQuestion);
    app.patch("/r/:id/decision", c.decide);
    app.use(errorHandler);
    return app;
  }

  function seed() {
    const question = { _id: "q1", text: "Can members see others' orders?", endpoint: "GET /orders/:id" };
    const review = {
      _id: REVIEW_ID,
      companyId: COMPANY,
      owner: "acme",
      repo: "shop",
      prNumber: 9,
      questions: Object.assign([question], { id: (id) => (id === "q1" ? question : null) }),
      save: jest.fn(async function () { return this; }),
      toJSON() { return { _id: this._id, decision: this.decision, questions: [question] }; },
    };
    mockReviews.length = 0;
    mockReviews.push(review);
    return { review, question };
  }

  beforeEach(() => mockRule.create.mockReset().mockResolvedValue({ _id: "rule1" }));

  test("an answer can become an approved rule for that endpoint", async () => {
    const { question } = seed();
    const res = await request(appFor(COMPANY))
      .post(`/r/${REVIEW_ID}/questions/q1/answer`)
      .send({ answer: "No", rule: { kind: "permission", text: "Members only see their own orders" } });
    expect(res.status).toBe(200);
    expect(question.answer).toBe("No");
    expect(mockRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "approved",
        kind: "permission",
        text: "Members only see their own orders",
        appliesTo: ["GET /orders/:id"],
        owner: "acme",
        repo: "shop",
      })
    );
    expect(question.ruleId).toBe("rule1");
  });

  test("another company can't answer or decide", async () => {
    seed();
    const app = appFor(OTHER);
    expect((await request(app).post(`/r/${REVIEW_ID}/questions/q1/answer`).send({ answer: "x" })).status).toBe(404);
    expect((await request(app).patch(`/r/${REVIEW_ID}/decision`).send({ decision: "approved" })).status).toBe(404);
  });

  test("the decision is recorded with who made it", async () => {
    const { review } = seed();
    const res = await request(appFor(COMPANY)).patch(`/r/${REVIEW_ID}/decision`).send({ decision: "rejected", note: "IDOR" });
    expect(res.status).toBe(200);
    expect(review).toMatchObject({ decision: "rejected", decisionNote: "IDOR", decidedBy: "u1" });
  });
});

describe("where the review sends requests", () => {
  test("without a dev URL on the watcher, nothing is sent", async () => {
    const PrReview = require("../model/PrReviewModel");
    const saved = [];
    PrReview.create = jest.fn(async (doc) => ({
      ...doc,
      tests: [],
      questions: [],
      save: jest.fn(async function () { saved.push(this); }),
    }));
    const client = { messages: { create: jest.fn() } };
    const review = await svc.reviewPullRequest({
      watcher: { _id: "w1", companyId: COMPANY, owner: "acme", repo: "shop", reviewBaseUrl: "" },
      installationId: 1,
      prNumber: 3,
      files: [],
      changed: [{ doc: { method: "GET", path: "/orders" }, change: "new endpoint" }],
      anthropicClient: client,
    });
    expect(review.verdict).toBe("review");
    expect(review.verdictReason).toMatch(/set the URL/);
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

describe("blocked tests", () => {
  const blocked = { type: "business_rule", passed: false, blocked: true, needs: "a shipped order" };
  test("a test waiting for data is never a failure", () => {
    expect(svc.verdictFor([ok(), blocked], []).verdict).toBe("review");
  });
  test("a real failure still fails the PR", () => {
    expect(svc.verdictFor([bad(), blocked], []).verdict).toBe("fail");
  });
  test("a blocked case is recorded without sending any request", async () => {
    const t = await svc.runCase({
      c: { type: "state", name: "can't cancel shipped", blocked: true, needs: "a shipped order" },
      doc: {},
      config: {},
      variables: {},
      client: null,
      endpoint: "POST /orders/:id/cancel",
    });
    expect(t).toMatchObject({ blocked: true, passed: false, needs: "a shipped order" });
    expect(t.request).toBeUndefined();
  });
});

describe("acceptance criteria", () => {
  const review = (criteria, tests, questions = []) => ({ criteria, tests, questions });
  const crit = (text, extra = {}) => ({ text, endpoints: ["GET /orders/:id/invoice"], testable: "api", ...extra });

  test("they are read from the PR and tied only to real endpoints", async () => {
    const client = {
      messages: {
        create: jest.fn(async () => ({
          content: [{ type: "text", text: JSON.stringify({ criteria: [
            { text: "Returns the invoice of an order", endpoints: ["GET /orders/:id/invoice", "GET /invented"], testable: "api" },
            { text: "The invoice email looks right", endpoints: [], testable: "manual" },
          ] }) }],
        })),
      },
    };
    const criteria = await svc.extractCriteria({
      title: "Add invoice",
      body: "## Acceptance criteria\n- returns the invoice\n- email looks right",
      endpointKeys: ["GET /orders/:id/invoice"],
      client,
    });
    expect(criteria).toEqual([
      { text: "Returns the invoice of an order", endpoints: ["GET /orders/:id/invoice"], testable: "api", status: "untested" },
      { text: "The invoice email looks right", endpoints: [], testable: "manual", status: "manual" },
    ]);
  });

  test("a criterion not met fails the PR even if every other test passes", () => {
    const r = review([crit("Returns 404 for a missing order")], [
      { ...ok(), criterion: null },
      { ...bad("functional"), criterion: 0 },
    ]);
    expect(svc.verdictForReview(r).verdict).toBe("fail");
    expect(r.criteria[0].status).toBe("not_met");
  });

  test("every criterion met passes", () => {
    const r = review([crit("Returns the invoice")], [{ ...ok(), criterion: 0 }]);
    expect(svc.verdictForReview(r).verdict).toBe("pass");
    expect(r.criteria[0].status).toBe("met");
  });

  test("a criterion nobody tested, or waiting for data, needs review", () => {
    const untested = review([crit("Returns the invoice"), crit("Totals include tax")], [{ ...ok(), criterion: 0 }]);
    expect(svc.verdictForReview(untested).verdict).toBe("review");
    expect(untested.criteria[1].status).toBe("untested");

    const waiting = review([crit("Returns the invoice")], [{ type: "functional", criterion: 0, blocked: true, passed: false }]);
    expect(svc.verdictForReview(waiting).verdict).toBe("review");
    expect(waiting.criteria[0].status).toBe("blocked");
  });

  test("a PR without criteria is never a pass", () => {
    const r = review([], [ok()]);
    const v = svc.verdictForReview(r);
    expect(v.verdict).toBe("review");
    expect(v.reason).toMatch(/no acceptance criteria/);
  });

  test("the PR comment lists each criterion with its result", () => {
    process.env.FRONTEND_URL = "";
    const md = svc.commentBody({
      _id: "r1",
      verdict: "fail",
      verdictReason: "1 of 2 acceptance criteria not met.",
      criteria: [
        { text: "Returns the invoice", status: "met" },
        { text: "404 for a missing order", status: "not_met" },
      ],
      tests: [],
      questions: [],
    });
    expect(md).toContain("### Acceptance criteria");
    expect(md).toContain("- ✅ Returns the invoice");
    expect(md).toContain("- ❌ 404 for a missing order");
  });
});

describe("bugs from the bug hunter", () => {
  const base = { criteria: [{ text: "Returns the invoice", endpoints: [], testable: "api" }], questions: [] };
  const passing = [{ ...ok(), criterion: 0 }];

  test("a critical or high bug fails the PR even with every criterion met", () => {
    const r = { ...base, tests: passing, bugs: [{ severity: "high", title: "IDOR on invoice" }] };
    expect(svc.verdictForReview(r).verdict).toBe("fail");
  });

  test("medium or low bugs need a person to look", () => {
    const r = { ...base, tests: passing, bugs: [{ severity: "low", title: "Wrong content-type" }] };
    expect(svc.verdictForReview(r).verdict).toBe("review");
  });

  test("they are listed in the PR comment", () => {
    const md = svc.commentBody({
      _id: "r1", verdict: "fail", verdictReason: "", criteria: [], tests: [], questions: [],
      bugs: [{ severity: "high", endpoint: "GET /orders/:id/invoice", title: "IDOR on invoice" }],
    });
    expect(md).toContain("### Bugs introduced by this PR (1)");
    expect(md).toContain("- **high** · GET /orders/:id/invoice: IDOR on invoice");
  });
});

test("the review's bug hunt is aimed at the PR's changes", () => {
  const note = svc.focusNoteFor({
    doc: { method: "GET", path: "/orders/:id/invoice" },
    change: "new endpoint",
    diffText: "+ router.get('/orders/:id/invoice')",
    criteria: [{ text: "Returns 404 for a missing order", endpoints: [], testable: "api" }],
  });
  expect(note).toContain("NOT A GENERAL ONE");
  expect(note).toContain("Returns 404 for a missing order");
  expect(note).toContain("router.get('/orders/:id/invoice')");
});

describe("triage before reporting", () => {
  const failing = (extra) => ({ type: "functional", passed: false, endpoint: "PATCH /orders/{order_id}/status", name: "x", expectedStatus: [200], reason: "Expected 200, got 409", request: { method: "PATCH", url: "u" }, response: { status: 409, error: "" }, ...extra });
  const claudeSays = (answer) => ({ messages: { create: jest.fn(async () => ({ content: [{ type: "text", text: JSON.stringify(answer) }] })) } });

  function reviewWith() {
    return {
      criteria: [{ text: "Returns units_count", endpoints: [], testable: "api" }],
      tests: [
        { type: "functional", criterion: 0, passed: true, response: { status: 200 } },
        failing({ name: "cancel order 2 again" }),
        failing({ name: "status 400 or 409", reason: "assertion about 409 couldn't be confirmed" }),
        failing({ type: "security", name: "sql injection", response: { status: 403, body: "<html>Blocked</html>", error: "" } }),
        failing({ type: "boundary", name: "huge id", response: { status: 500, error: "" } }),
      ],
      bugs: [
        { severity: "high", endpoint: "GET /orders/{order_id}", title: "500 on huge id" },
        { severity: "high", endpoint: "PATCH /orders/{order_id}/status", title: "cancel returned 409" },
      ],
      questions: Array.from({ length: 9 }, (_, i) => ({ text: `q${i}` })),
    };
  }

  test("only the PR's own defects block it; the rest is sorted out", async () => {
    const review = reviewWith();
    await svc.triageFindings({
      review,
      diffText: "",
      client: claudeSays({
        tests: [
          { i: 0, as: "needs_data", note: "an order that isn't cancelled" },
          { i: 1, as: "olivia_check", note: "400 was one of the expected statuses" },
          { i: 2, as: "environment", note: "Cloudflare blocked the payload" },
          { i: 3, as: "pre_existing", note: "path ids were never bounded" },
        ],
        bugs: [{ i: 0, as: "pre_existing" }, { i: 1, as: "needs_data" }],
        keepQuestions: [0, 3, 4],
      }),
    });
    expect(review.tests[1]).toMatchObject({ blocked: true, needs: "an order that isn't cancelled" });
    expect(review.tests[2]).toMatchObject({ passed: true, triage: "olivia_check" });
    expect(review.tests[3]).toMatchObject({ passed: true, triage: "environment" });
    expect(review.tests[4]).toMatchObject({ passed: false, triage: "pre_existing" });
    expect(review.bugs).toEqual([expect.objectContaining({ title: "500 on huge id", introduced: false })]);
    expect(review.questions.map((q) => q.text)).toEqual(["q0", "q3", "q4"]);

    // With every criterion met, pre-existing bugs don't fail the ticket.
    review.questions = [];
    review.tests = review.tests.filter((t) => !t.blocked);
    const v = svc.verdictForReview(review);
    expect(v.verdict).toBe("pass");
    expect(v.reason).toMatch(/already there before this PR/);
  });

  test("never more than 5 questions, even if triage keeps more", async () => {
    const review = reviewWith();
    await svc.triageFindings({ review, diffText: "", client: claudeSays({ keepQuestions: [0, 1, 2, 3, 4, 5, 6] }) });
    expect(review.questions).toHaveLength(5);
  });

  test("the comment separates the PR's bugs from the ones to open separately", () => {
    const md = svc.commentBody({
      _id: "r1", verdict: "pass", verdictReason: "", criteria: [], tests: [], questions: [],
      bugs: [
        { severity: "high", endpoint: "GET /orders/{order_id}", title: "500 on huge id", introduced: false },
        { severity: "low", endpoint: "GET /products/{product_id}", title: "new field rounding" },
      ],
    });
    expect(md).toContain("### Bugs introduced by this PR (1)");
    expect(md).toContain("### Bugs that were already there (1), to open separately");
  });
});

describe("steps that use what an earlier step answered", () => {
  const bodies = [{ quantity: 12, items: [{ id: 7 }] }, { total: 99.5 }];

  test("a live value fills the next request, keeping its type", () => {
    const { step, missing } = svc.fillStepRefs(
      {
        endpoint: "POST /products/:id/stock",
        path: "/products/{{step2.total}}/x/{{step1.items.0.id}}",
        query: { dry_run: "true", expected: "{{step1.quantity}}" },
        headers: {},
        body: { current_quantity: "{{step1.quantity}}", note: "had {{step1.quantity}}", list: ["{{step2.total}}"] },
      },
      bodies
    );
    expect(missing).toBeUndefined();
    expect(step.path).toBe("/products/99.5/x/7");
    expect(step.query).toEqual({ dry_run: "true", expected: 12 });
    expect(step.body).toEqual({ current_quantity: 12, note: "had 12", list: [99.5] });
  });

  test("a value an earlier step didn't return blocks the step instead of guessing", () => {
    expect(svc.fillStepRefs({ path: "/x", body: { q: "{{step1.stock}}" } }, bodies).missing).toBe("{{step1.stock}}");
    expect(svc.fillStepRefs({ path: "/x/{{step3.id}}" }, bodies).missing).toBe("{{step3.id}}");
  });

  test("steps without references are left as they are", () => {
    const raw = { path: "/orders/{{ORDER_ID}}", body: null };
    expect(svc.fillStepRefs(raw, []).step).toEqual({ ...raw, query: undefined, headers: undefined });
  });
});
