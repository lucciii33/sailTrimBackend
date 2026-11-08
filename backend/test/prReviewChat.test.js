const mockReview = {};
jest.mock("../model/PrReviewModel", () => ({
  TEST_TYPES: ["functional", "business_rule", "boundary", "security", "regression"],
  findOne: jest.fn(async () => mockReview.current),
}));
jest.mock("../model/ApiWatcherModel", () => ({
  findOne: () => ({ lean: async () => ({ reviewBaseUrl: mockReview.baseUrl }) }),
}));
jest.mock("../model/DocModel", () => ({
  find: async () => [{ method: "GET", path: "/orders/:id", owner: "acme", repo: "shop", branch: "dev" }],
}));
jest.mock("../services/businessRuleService", () => ({ rulesFor: async () => [], rulesNote: () => "" }));
jest.mock("../services/apiQAService", () => ({
  resolveDocRunConfig: async () => ({ config: { baseUrl: "https://repo-default.example" }, variables: { userId: "7" } }),
  executeTestCase: jest.fn(async ({ config }) => ({
    request: { method: "GET", url: `${config.baseUrl}/orders/123`, headers: { Authorization: "Bearer real" } },
    response: { status: 403, durationMs: 5, body: { error: "forbidden" }, error: null },
  })),
}));
jest.mock("../services/apiSuiteService", () => ({ judgeAssertions: async () => [] }));

const { executeTestCase } = require("../services/apiQAService");
const { chat } = require("../services/prReviewChatService");

function newReview() {
  const r = {
    _id: "r1",
    owner: "acme",
    repo: "shop",
    branch: "dev",
    prNumber: 4,
    prTitle: "orders",
    watcherId: "w1",
    verdict: "review",
    verdictReason: "",
    tests: [{ endpoint: "GET /orders/:id", type: "security", name: "other user's order", passed: false, blocked: true, needs: "an order of another user", reason: "Blocked" }],
    questions: [],
    chat: [],
    save: jest.fn(async () => r),
  };
  return r;
}

function scripted(...responses) {
  return { messages: { create: jest.fn(async () => responses.shift()) } };
}

beforeEach(() => {
  mockReview.current = newReview();
  mockReview.baseUrl = "https://api-dev.example";
  executeTestCase.mockClear();
});

test("the agent runs the test the user asks for, against the dev URL, and remembers the chat", async () => {
  const client = scripted(
    {
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "run_test",
          input: { endpoint: "GET /orders/:id", type: "security", name: "order 123 as user 7", method: "GET", path: "/orders/123", expectedStatus: [403, 404] },
        },
      ],
    },
    { content: [{ type: "text", text: "Order 123 returned 403 as expected." }] }
  );
  const review = await chat({ reviewId: "r1", companyId: "c1", message: "usa el pedido 123", anthropicClient: client });
  expect(executeTestCase.mock.calls[0][0].config.baseUrl).toBe("https://api-dev.example");
  const added = review.tests.find((t) => t.source === "chat");
  expect(added).toMatchObject({ passed: true, endpoint: "GET /orders/:id" });
  expect(added.request.headers.Authorization).toBe("[redacted]");
  expect(review.chat.map((m) => m.role)).toEqual(["user", "agent"]);
  expect(review.chat[1].text).toContain("403");
});

test("a value the user gives is only proposed as a variable, never saved by the agent", async () => {
  const client = scripted(
    { content: [{ type: "tool_use", id: "t1", name: "propose_variable", input: { key: "shippedOrderId", value: "123" } }] },
    { content: [{ type: "text", text: "¿Lo guardo?" }] }
  );
  const review = await chat({ reviewId: "r1", companyId: "c1", message: "el 123 es un pedido enviado", anthropicClient: client });
  expect(review.chat[1].actions).toEqual([
    expect.objectContaining({ kind: "save_variable", key: "shippedOrderId", value: "123" }),
  ]);
});

test("secrets are never proposed as variables", async () => {
  const client = scripted(
    { content: [{ type: "tool_use", id: "t1", name: "propose_variable", input: { key: "apiToken", value: "abc" } }] },
    { content: [{ type: "text", text: "ok" }] }
  );
  const review = await chat({ reviewId: "r1", companyId: "c1", message: "token abc", anthropicClient: client });
  expect(review.chat[1].actions).toEqual([]);
});

test("without a dev URL the agent sends nothing", async () => {
  mockReview.baseUrl = "";
  const client = scripted(
    { content: [{ type: "tool_use", id: "t1", name: "run_test", input: { endpoint: "GET /orders/:id", type: "functional", name: "x", method: "GET", path: "/orders/1", expectedStatus: [200] } }] },
    { content: [{ type: "text", text: "No dev URL." }] }
  );
  await chat({ reviewId: "r1", companyId: "c1", message: "prueba", anthropicClient: client });
  expect(executeTestCase).not.toHaveBeenCalled();
});
