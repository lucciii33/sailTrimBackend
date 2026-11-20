const jwt = require("jsonwebtoken");

process.env.JWT_SECRET_NODE = "test-secret";
process.env.FRONTEND_URL = "https://app.olivia.test";

const mockInstalls = new Map();
jest.mock("../model/Installation", () => ({
  findOne: ({ installationId }) => ({ select: async () => mockInstalls.get(installationId) || null }),
  findOneAndUpdate: async ({ installationId }, update) => {
    mockInstalls.set(installationId, { ...(mockInstalls.get(installationId) || {}), ...update });
    return mockInstalls.get(installationId);
  },
}));
jest.mock("../model/userModel", () => ({
  findById: () => ({ select: async () => ({ companyId: "c1" }) }),
  findByIdAndUpdate: async () => ({}),
}));
jest.mock("../model/PendingInstall", () => ({ create: async () => ({}) }));
jest.mock("../model/BackfillJob", () => ({}));
jest.mock("../model/DocModel", () => ({}));
jest.mock("../services/instanceRouter", () => ({
  callbackTarget: async () => null,
  unwrapState: (s) => s,
  wrapState: (s) => s,
}));
jest.mock("../services/installationRepointService", () => ({ repointToInstallation: async () => {} }));
const mockLive = { repos: [] };
jest.mock("../services/githubService", () => ({
  getOctokit: async () => ({}),
  fetchInstallationRepos: async () => mockLive.repos,
  withoutRemovedRepos: (repos) => repos,
  getApp: async () => ({}),
}));
jest.mock("../services/docService", () => ({}));
jest.mock("../services/userKeyService", () => ({}));
jest.mock("../services/githubUserTokenService", () => ({ saveUserGithubTokens: async () => {} }));

const { githubCallback } = require("../controllers/githubController");

const repo = (name) => ({ name, full_name: `aiera-inc/${name}`, owner: { login: "aiera-inc", type: "Organization" } });
const state = () => jwt.sign({ sub: "u1", purpose: "github_connect", returnTo: "" }, "test-secret");

function call(query) {
  const res = {
    statusCode: 200,
    body: "",
    redirectedTo: null,
    status(c) { this.statusCode = c; return this; },
    type() { return this; },
    send(b) { this.body = b; return this; },
    redirect(u) { this.redirectedTo = u; return this; },
  };
  return githubCallback({ query }, res).then(() => res);
}

beforeEach(() => {
  mockInstalls.clear();
});

test("a member picking another repo on an org that already has the app is told, with a link for an owner", async () => {
  mockInstalls.set(158249148, { repos: [{ repoName: "aiera-api-mcp-chat-test", repoFullName: "aiera-inc/aiera-api-mcp-chat-test" }], removedRepos: [] });
  mockLive.repos = [repo("aiera-api-mcp-chat-test")];
  const res = await call({ installation_id: "158249148", setup_action: "install", state: state() });
  expect(res.redirectedTo).toBeNull();
  expect(res.body).toContain("No new repository was added");
  expect(res.body).toContain("https://github.com/organizations/aiera-inc/settings/installations/158249148");
  expect(res.body).toContain("aiera-api-mcp-chat-test");
});

test("a repo that did come through goes straight back to Olivia", async () => {
  mockInstalls.set(158249148, { repos: [{ repoName: "a", repoFullName: "aiera-inc/a" }], removedRepos: [] });
  mockLive.repos = [repo("a"), repo("b")];
  const res = await call({ installation_id: "158249148", setup_action: "update", state: state() });
  expect(res.redirectedTo).toBe("https://app.olivia.test/docs?installed=1");
});

test("a first install goes straight back to Olivia", async () => {
  mockLive.repos = [repo("a")];
  const res = await call({ installation_id: "999", setup_action: "install", state: state() });
  expect(res.redirectedTo).toBe("https://app.olivia.test/docs?installed=1");
});
