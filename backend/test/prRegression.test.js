// A validated PR review's tests become regression cases on each endpoint.

const mockSaved = [];
const mockSuites = new Map();

jest.mock("../model/PrReviewModel", () => ({ findOne: jest.fn() }));
jest.mock("../model/ApiWatcherModel", () => ({
  findById: () => ({ select: () => ({ lean: async () => ({ reviewBaseUrl: "https://dev.example.com/api" }) }) }),
}));
jest.mock("../model/DocModel", () => ({
  find: jest.fn(async (q) =>
    q.path === "/orders/:id"
      ? [{ _id: "doc1", method: "GET", path: "/orders/:id", owner: "o", repo: "r", branch: "dev" }]
      : []
  ),
}));
jest.mock("../model/ApiSuiteModel", () => {
  function ApiSuite(data) {
    Object.assign(this, data);
    this._id = "suite-new";
    this.save = async () => mockSaved.push(this);
  }
  ApiSuite.findOne = jest.fn(async ({ docId }) => mockSuites.get(docId) || null);
  return ApiSuite;
});
jest.mock("../services/apiSuiteService", () => ({
  ownerFieldsFor: () => ({ owner: "o", repo: "r", branch: "dev", projectId: null }),
  sectionForDoc: () => "orders",
  suggestMoreCases: jest.fn(async () => [
    { name: "Bogus id", covers: "404 on unknown order", category: "not_found", method: "GET", path: "/orders/nope", expectedStatus: [404], assertions: [] },
  ]),
}));

const PrReview = require("../model/PrReviewModel");
const { createRegressionFromReview, caseFromTest, relativePath } = require("../services/prRegressionService");

function review(tests) {
  return {
    _id: "rev1",
    status: "done",
    watcherId: "w1",
    owner: "o",
    repo: "r",
    branch: "dev",
    prNumber: 42,
    criteria: [{ text: "Shows the order", endpoints: ["GET /orders/:id"], testable: "api" }],
    tests,
    save: jest.fn(async () => {}),
  };
}

const passed = {
  _id: "t1",
  type: "functional",
  endpoint: "GET /orders/:id",
  name: "Reads order 7",
  covers: "Shows the order",
  expectedStatus: [200],
  assertions: ["status is shipped"],
  passed: true,
  request: {
    method: "GET",
    url: "https://dev.example.com/api/orders/7?full=1",
    headers: { Authorization: "[redacted]", "X-Tenant": "acme", "content-length": "0" },
    body: null,
  },
  response: { status: 200 },
};

beforeEach(() => {
  mockSaved.length = 0;
  mockSuites.clear();
});

test("strips the review URL's prefix and keeps the query", () => {
  expect(relativePath("https://dev.example.com/api/orders/7?full=1", "/api")).toBe("/orders/7?full=1");
  expect(relativePath("https://dev.example.com/orders/7", "/")).toBe("/orders/7");
});

test("a passed test becomes a case without credentials", () => {
  const c = caseFromTest(passed, "/api", 42);
  expect(c).toMatchObject({
    method: "GET",
    path: "/orders/7?full=1",
    headers: { "X-Tenant": "acme" },
    expectedStatus: [200],
    assertions: ["status is shipped"],
    category: "happy_path",
    fromPr: 42,
    fromReviewTest: "t1",
  });
});

test("failed, blocked and triaged tests are not reused", () => {
  expect(caseFromTest({ ...passed, passed: false }, "/api", 1)).toBeNull();
  expect(caseFromTest({ ...passed, blocked: true }, "/api", 1)).toBeNull();
  expect(caseFromTest({ ...passed, triage: "olivia_check" }, "/api", 1)).toBeNull();
});

test("a no-credentials test stays a no-credentials case", () => {
  const c = caseFromTest({ ...passed, expectedStatus: [401], request: { ...passed.request, headers: {} } }, "/api", 1);
  expect(c.category).toBe("unauthorized");
  expect(c.headers).toEqual({ Authorization: "" });
});

test("adds the review's tests and the agent's to the endpoint's suite", async () => {
  const r = review([passed, { ...passed, _id: "t2", passed: false }]);
  PrReview.findOne.mockResolvedValue(r);
  await createRegressionFromReview({ reviewId: "rev1", companyId: "c1", userId: "u1" });

  expect(mockSaved).toHaveLength(1);
  expect(mockSaved[0].kind).toBe("regression");
  expect(mockSaved[0].cases.map((c) => c.name)).toEqual(["Reads order 7", "Bogus id"]);
  expect(mockSaved[0].cases[1].fromPr).toBe(42);
  expect(r.regression).toEqual([
    { endpoint: "GET /orders/:id", suiteId: "suite-new", fromReview: 1, generated: 1, error: "" },
  ]);
});

test("keeps what the suite had and doesn't copy a test twice", async () => {
  const existing = {
    _id: "suite-old",
    cases: [{ name: "Old one" }, { name: "Reads order 7", fromReviewTest: "t1" }],
    save: async function () {
      mockSaved.push(this);
    },
  };
  mockSuites.set("doc1", existing);
  PrReview.findOne.mockResolvedValue(review([passed]));
  await createRegressionFromReview({ reviewId: "rev1", companyId: "c1", userId: "u1" });
  expect(existing.cases.map((c) => c.name)).toEqual(["Old one", "Reads order 7", "Bogus id"]);
});

test("an endpoint without docs is reported, not dropped silently", async () => {
  const r = review([{ ...passed, endpoint: "POST /refunds" }]);
  r.criteria = [];
  PrReview.findOne.mockResolvedValue(r);
  await createRegressionFromReview({ reviewId: "rev1", companyId: "c1", userId: "u1" });
  expect(r.regression[0].error).toMatch(/no docs/);
  expect(mockSaved).toHaveLength(0);
});
