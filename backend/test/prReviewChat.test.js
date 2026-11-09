const mockReview = {};
jest.mock("../model/PrReviewModel", () => ({
  TEST_TYPES: ["functional", "business_rule", "boundary", "security", "regression"],
  findOne: jest.fn(async () => mockReview.current),
}));
jest.mock("../model/ApiWatcherModel", () => ({
  findOne: () => ({ lean: async () => ({ reviewBaseUrl: mockReview.baseUrl }) }),
}));
jest.mock("../model/DocModel", () => ({
  find: async () => [
    { method: "GET", path: "/orders/:id", owner: "acme", repo: "shop", branch: "dev" },
    { method: "POST", path: "/orders", owner: "acme", repo: "shop", branch: "dev" },
  ],
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

test("the agent sets up data on any endpoint of the API, without recording it as a test", async () => {
  const client = scripted(
    {
      content: [
        { type: "tool_use", id: "t1", name: "prepare_data", input: { endpoint: "POST /orders", method: "POST", path: "/orders", body: { customer_name: "QA" } } },
      ],
    },
    { content: [{ type: "text", text: "Created." }] }
  );
  const before = mockReview.current.tests.length;
  const review = await chat({ reviewId: "r1", companyId: "c1", message: "crea una orden", anthropicClient: client });
  expect(executeTestCase).toHaveBeenCalledTimes(1);
  expect(executeTestCase.mock.calls[0][0].config.baseUrl).toBe("https://api-dev.example");
  expect(review.tests).toHaveLength(before);
  expect(client.messages.create.mock.calls[0][0].messages[0].content).toContain("- POST /orders");
});

test("a test that failed on the wrong data stops counting against the PR", async () => {
  const client = scripted(
    {
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "run_test",
          input: { endpoint: "GET /orders/:id", type: "functional", name: "cancelled order can't be edited", method: "GET", path: "/orders/2", expectedStatus: [200] },
        },
      ],
    },
    { content: [{ type: "tool_use", id: "t2", name: "mark_wrong_data", input: { name: "cancelled order can't be edited", needs: "an order in cancelled status" } }] },
    { content: [{ type: "text", text: "Order 2 isn't cancelled." }] }
  );
  const review = await chat({ reviewId: "r1", companyId: "c1", message: "la 2 está cancelada", anthropicClient: client });
  const t = review.tests.find((x) => x.source === "chat");
  expect(t).toMatchObject({ passed: false, blocked: true, needs: "an order in cancelled status" });
  expect(review.verdict).not.toBe("fail");
});
