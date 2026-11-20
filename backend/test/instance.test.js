const express = require("express");
const request = require("supertest");

jest.mock("../model/userModel", () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn(),
}));
jest.mock("../model/companyModel", () => ({ create: jest.fn() }));
jest.mock("../model/companyInviteModel", () => ({
  findOne: jest.fn().mockResolvedValue(null),
  updateOne: jest.fn(),
}));
jest.mock("../services/auditLogger", () => ({ logEvent: jest.fn() }));

const mockVerifyIdToken = jest.fn();
jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const User = require("../model/userModel");
const Company = require("../model/companyModel");
const CompanyInvite = require("../model/companyInviteModel");
const { registerUser, googleLogin } = require("../controllers/userController");
const { errorHandler } = require("../middleware/errorMiddleware");
const instance = require("../config/instance");

const app = express();
app.use(express.json());
app.post("/register", registerUser);
app.post("/google", googleLogin);
app.use(errorHandler);

const ORIGINAL_ENV = process.env;
const NEW_USER = {
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@acme.com",
  password: "Correct-Horse-Battery-9!",
  terms: true,
};

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.OLIVIA_DEDICATED;
  delete process.env.ALLOWED_ORIGINS;
  jest.clearAllMocks();
  User.findOne.mockResolvedValue(null);
  CompanyInvite.findOne.mockResolvedValue(null);
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("dedicated instance settings", () => {
  test("refuses to start without its required settings", () => {
    process.env.OLIVIA_DEDICATED = "true";
    for (const name of instance.REQUIRED_ENV) delete process.env[name];
    expect(() => instance.assertDedicatedConfig()).toThrow(/MONGO_URL/);
  });

  test("the shared service does not need them", () => {
    for (const name of instance.REQUIRED_ENV) delete process.env[name];
    expect(() => instance.assertDedicatedConfig()).not.toThrow();
  });

  test("CORS only admits the instance's own frontend", () => {
    process.env.OLIVIA_DEDICATED = "true";
    process.env.FRONTEND_URL = "https://acme.oliviatools.com/";
    const { origin } = instance.corsOptions();
    const check = (value) => {
      let result;
      origin(value, (_, allowed) => (result = allowed));
      return result;
    };
    expect(check("https://acme.oliviatools.com")).toBe(true);
    expect(check("https://evil.example")).toBe(false);
    expect(check(undefined)).toBe(true);
  });
});

describe("sign-up on a dedicated instance", () => {
  test("registering without an invitation is refused", async () => {
    process.env.OLIVIA_DEDICATED = "true";
    const res = await request(app).post("/register").send(NEW_USER);
    expect(res.status).toBe(403);
    expect(User.create).not.toHaveBeenCalled();
  });

  test("a Google account without an invitation gets no account", async () => {
    process.env.OLIVIA_DEDICATED = "true";
    process.env.GOOGLE_CLIENT_ID = "client";
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "x@evil.example", email_verified: true, sub: "1" }),
    });
    const res = await request(app).post("/google").send({ credential: "t" });
    expect(res.status).toBe(403);
    expect(User.create).not.toHaveBeenCalled();
    expect(Company.create).not.toHaveBeenCalled();
  });

  test("a Google account joins the workspace that invited it", async () => {
    process.env.OLIVIA_DEDICATED = "true";
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.JWT_SECRET_NODE = "secret";
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "ana@acme.com", email_verified: true, sub: "1" }),
    });
    CompanyInvite.findOne.mockResolvedValue({ companyId: "c1", role: "member" });
    User.create.mockResolvedValue({ id: "u1", _id: "u1", email: "ana@acme.com", companyId: "c1", save: jest.fn() });
    await request(app).post("/google").send({ credential: "t" });
    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "c1", role: "member" })
    );
    expect(Company.create).not.toHaveBeenCalled();
  });

  test("the shared service still allows open sign-up", async () => {
    User.create.mockResolvedValue({ _id: "u1", save: jest.fn() });
    Company.create.mockResolvedValue({ _id: "c1" });
    process.env.JWT_SECRET_NODE = "secret";
    const res = await request(app).post("/register").send(NEW_USER);
    expect(res.status).not.toBe(403);
    expect(User.create).toHaveBeenCalled();
  });
});
