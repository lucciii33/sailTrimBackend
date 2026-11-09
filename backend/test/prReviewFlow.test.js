// The whole review of a merged PR, as the watcher runs it: GitHub, Claude and
// the API under test are fakes; everything in between is the real code.
const mockStore = { reviews: [] };
jest.mock("../model/PrReviewModel", () => {
  const actual = jest.requireActual("../model/PrReviewModel");
  return {
    TEST_TYPES: actual.TEST_TYPES,
    create: jest.fn(async (fields) => {
      const doc = new actual(fields);
      doc.save = jest.fn(async () => doc);
      mockStore.reviews.push(doc);
      return doc;
    }),
  };
});

const mockGithub = { comments: [] };
jest.mock("../services/githubService", () => ({
  getOctokit: async () => ({
    request: async (route, params) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/pulls/")) {
        return {
          data: {
            title: "Add GET /orders/{id}/invoice",
            body: "## Acceptance criteria\n- Returns the invoice of an existing order\n- Returns 404 for an order that doesn't exist\n- Only the order's owner can see it",
          },
        };
      }
      if (route.startsWith("POST /repos/{owner}/{repo}/issues/")) {
        mockGithub.comments.push(params.body);
        return { data: { html_url: "https://github.com/x/y/pull/29#c1" } };
      }
      throw new Error(`unexpected ${route}`);
    },
  }),
}));

jest.mock("../services/businessRuleService", () => ({ rulesFor: async () => [], rulesNote: () => "" }));
const mockApi = { findBugs: jest.fn(), resolveDocRunConfig: jest.fn() };
jest.mock("../services/apiQAService", () => ({
  resolveDocRunConfig: (...a) => mockApi.resolveDocRunConfig(...a),
  findBugs: (...a) => mockApi.findBugs(...a),
  // The fake API: the invoice exists, a missing order wrongly returns 200.
  executeTestCase: jest.fn(async ({ testCase, config }) => {
    const missing = /999999/.test(testCase.path);
    return {
      request: { method: testCase.method, url: `${config.baseUrl}${testCase.path}`, headers: { Authorization: "Bearer real" } },
      response: { status: missing ? 200 : 200, durationMs: 3, body: { total: 10 }, error: null },
    };
  }),
}));
jest.mock("../services/apiSuiteService", () => ({ judgeAssertions: async () => [] }));

const svc = require("../services/prReviewService");

const INVOICE = { _id: "d1", method: "GET", path: "/orders/{order_id}/invoice", owner: "lucciii33", repo: "olivia-demo", branch: "main" };
const KEY = "GET /orders/{order_id}/invoice";

function claude() {
  return {
    messages: {
      create: jest.fn(async ({ system }) => {
        if (system.includes("list its ACCEPTANCE CRITERIA")) {
          return { content: [{ type: "text", text: JSON.stringify({ criteria: [
            { text: "Returns the invoice of an existing order", endpoints: [KEY], testable: "api" },
            { text: "Returns 404 for an order that doesn't exist", endpoints: [KEY], testable: "api" },
            { text: "Only the order's owner can see it", endpoints: [KEY], testable: "api" },
          ] }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({
          cases: [
            { type: "functional", criterion: 0, name: "invoice of order", method: "GET", path: "/orders/{{order_id}}/invoice", expectedStatus: [200] },
            { type: "functional", criterion: 1, name: "missing order", method: "GET", path: "/orders/999999/invoice", expectedStatus: [404] },
            { type: "security", criterion: 2, name: "other user's order", blocked: true, needs: "an order owned by another user" },
          ],
          questions: [],
        }) }] };
      }),
    },
  };
}

const watcher = { _id: "w1", companyId: "c1", userId: "u1", owner: "lucciii33", repo: "olivia-demo", branch: "main", reviewBaseUrl: "https://api-dev.example" };

beforeEach(() => {
  mockStore.reviews.length = 0;
  mockGithub.comments.length = 0;
  jest.clearAllMocks();
  mockApi.resolveDocRunConfig.mockResolvedValue({ config: { baseUrl: "https://prod.example" }, variables: { order_id: "42", product_id: "7" } });
  mockApi.findBugs.mockResolvedValue({
    executions: [{ name: "invoice of a deleted order", isBug: true, bugSeverity: "high", bugTitle: "Invoice served for a deleted order", request: { method: "GET", url: "x", headers: { Authorization: "Bearer real" } }, response: { status: 200, body: {} } }],
    warnings: [],
  });
});

test("a merged PR is validated against its criteria, attacked on its changes, and commented", async () => {
  const review = await svc.reviewPullRequest({
    watcher,
    installationId: 1,
    prNumber: 29,
    files: [{ filename: "app.py", patch: "+ @app.get('/orders/{order_id}/invoice')" }],
    changed: [{ doc: INVOICE, change: "new endpoint" }],
    allDocs: [INVOICE],
    anthropicClient: claude(),
  });

  // Read the ticket.
  expect(review.criteria.map((c) => c.status)).toEqual(["met", "not_met", "blocked"]);
  // Used the repo's variables and the dev URL, never the configured one.
  const { executeTestCase } = require("../services/apiQAService");
  expect(executeTestCase.mock.calls[0][0].config.baseUrl).toBe("https://api-dev.example");
  expect(executeTestCase.mock.calls[0][0].variables).toEqual({ order_id: "42", product_id: "7" });
  // The dedicated hunt: dev URL, aimed at the change.
  const hunt = mockApi.findBugs.mock.calls[0][0];
  expect(hunt.baseUrl).toBe("https://api-dev.example");
  expect(hunt.focusNote).toContain("Returns 404 for an order that doesn't exist");
  expect(review.bugs[0]).toMatchObject({ severity: "high", endpoint: KEY });
  expect(review.bugs[0].request.headers.Authorization).toBe("[redacted]");
  // Verdict and comment.
  expect(review.verdict).toBe("fail");
  expect(review.status).toBe("done");
  expect(mockGithub.comments[0]).toContain("❌ Returns 404 for an order that doesn't exist");
  expect(mockGithub.comments[0]).toContain("🚫 Only the order's owner can see it");
  expect(mockGithub.comments[0]).toContain("Invoice served for a deleted order");
});

test("without the repo's QA config it asks for it instead of guessing", async () => {
  mockApi.resolveDocRunConfig.mockRejectedValue(new Error("No QA config found for lucciii33/olivia-demo. Set baseUrl + auth first."));
  const review = await svc.reviewPullRequest({
    watcher, installationId: 1, prNumber: 29, files: [], changed: [{ doc: INVOICE, change: "new endpoint" }], allDocs: [INVOICE], anthropicClient: claude(),
  });
  expect(review.verdict).toBe("review");
  expect(review.questions[0].text).toMatch(/Set the auth and variables in this repo's API tests settings/);
  expect(mockApi.findBugs).not.toHaveBeenCalled();
});

test("missing data found by the hunt becomes a question", async () => {
  mockApi.findBugs.mockResolvedValue({ executions: [], warnings: [{ type: "missing_data", params: ["order_id"] }] });
  const review = await svc.reviewPullRequest({
    watcher, installationId: 1, prNumber: 29, files: [], changed: [{ doc: INVOICE, change: "new endpoint" }], allDocs: [INVOICE], anthropicClient: claude(),
  });
  expect(review.questions.map((q) => q.text).join(" ")).toMatch(/real value for \{order_id\}/);
});
