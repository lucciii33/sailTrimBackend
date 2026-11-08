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
