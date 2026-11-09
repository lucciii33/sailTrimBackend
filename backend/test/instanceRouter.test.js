const express = require("express");
const request = require("supertest");
const crypto = require("crypto");

const mockRoutes = [];
jest.mock("../model/InstanceRouteModel", () => ({
  findOne: (f) => ({
    lean: async () => mockRoutes.find((r) => r.kind === f.kind && r.value === f.value) || null,
  }),
  updateOne: async () => {},
}));
const mockWatchers = { onBranchUpdated: jest.fn().mockResolvedValue(1) };
jest.mock("../services/watcherService", () => mockWatchers);
jest.mock("../services/mcpWatcherService", () => ({ onBranchUpdated: jest.fn().mockResolvedValue(0) }));
jest.mock("../services/slackService", () => ({ postMessage: jest.fn() }));
// Database lookups the merge handler makes (Slack settings) find nothing.
const mockEmpty = () => {
  const q = { select: () => q, lean: async () => null, then: (r) => Promise.resolve(null).then(r) };
  return q;
};
for (const model of ["Installation", "userModel", "companyModel", "DocModel"]) {
  jest.mock(`../model/${model}`, () => ({ findOne: mockEmpty, findById: mockEmpty, find: mockEmpty }));
}

const router = require("../services/instanceRouter");
const { handleWebhook } = require("../controllers/webhookController");

const SECRET = "test-secret";
const app = express();
app.post("/webhook", express.raw({ type: "application/json" }), handleWebhook);

function mergeEvent(installationId) {
  return {
    action: "closed",
    installation: { id: installationId },
    repository: { name: "olivia-demo", owner: { login: "lucciii33" } },
    pull_request: { number: 7, title: "x", merged: true, base: { ref: "main" }, user: { login: "u" } },
    sender: { id: 777 },
  };
}

function send(payload) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  return request(app)
    .post("/webhook")
    .set("content-type", "application/json")
    .set("x-github-event", "pull_request")
    .set("x-hub-signature-256", sig)
    .send(body);
}

beforeEach(() => {
  mockRoutes.length = 0;
  mockWatchers.onBranchUpdated.mockClear();
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.OLIVIA_INSTANCES = JSON.stringify({ acme: "http://127.0.0.1:1" });
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

test("a merge fires this backend's watchers even when the installation was connected from an instance", async () => {
  mockRoutes.push({ kind: "installation", value: "166996024", instance: "acme" });
  const res = await send(mergeEvent(166996024));
  expect(res.status).toBe(200);
  expect(mockWatchers.onBranchUpdated).toHaveBeenCalledWith(
    expect.objectContaining({ owner: "lucciii33", repo: "olivia-demo", branch: "main" })
  );
  // ...and the instance still gets its copy.
  expect(global.fetch).toHaveBeenCalledWith("http://127.0.0.1:1/webhook", expect.anything());
});

test("an installation never connected from an instance is not copied to it", async () => {
  await send(mergeEvent(5));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(mockWatchers.onBranchUpdated).toHaveBeenCalled();
});

test("the person who connected is never a reason to send someone else's events", async () => {
  const created = { action: "created", installation: { id: 9 }, requester: { id: 777 }, sender: { id: 777 } };
  expect(await router.webhookTarget("installation", created)).toBeNull();
});

test("without OLIVIA_INSTANCES nothing is copied", async () => {
  delete process.env.OLIVIA_INSTANCES;
  mockRoutes.push({ kind: "installation", value: "166996024", instance: "acme" });
  await send(mergeEvent(166996024));
  expect(global.fetch).not.toHaveBeenCalled();
});
