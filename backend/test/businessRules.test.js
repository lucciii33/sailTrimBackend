const express = require("express");
const request = require("supertest");

const mockRules = [];
jest.mock("../model/BusinessRuleModel", () => {
  const match = (doc, filter) =>
    Object.entries(filter).every(([k, v]) => {
      if (k === "$or") return v.some((f) => match(doc, f));
      if (v && typeof v === "object" && "$in" in v) return v.$in.includes(doc[k]);
      if (v && typeof v === "object" && "$size" in v) return doc[k].length === v.$size;
      if (Array.isArray(doc[k]) && typeof v === "string") return doc[k].includes(v);
      return String(doc[k]) === String(v);
    });
  const query = (rows) => ({
    sort: () => query(rows),
    limit: (n) => query(rows.slice(0, n)),
    select: () => query(rows),
    lean: async () => rows,
  });
  const model = {
    KINDS: ["rule", "permission", "state", "invariant", "known_bug"],
    STATUSES: ["proposed", "approved", "rejected"],
    find: (filter) => query(mockRules.filter((r) => match(r, filter))),
    insertMany: async (docs) => {
      mockRules.push(...docs);
      return docs;
    },
    create: async (doc) => {
      const row = { _id: `r${mockRules.length + 1}`, ...doc };
      mockRules.push(row);
      return row;
    },
    findOneAndUpdate: async (filter, { $set }) => {
      const row = mockRules.find((r) => match(r, filter));
      if (!row) return null;
      Object.assign(row, $set);
      return row;
    },
    deleteOne: async (filter) => {
      const i = mockRules.findIndex((r) => match(r, filter));
      if (i < 0) return { deletedCount: 0 };
      mockRules.splice(i, 1);
      return { deletedCount: 1 };
    },
  };
  return model;
});

const rules = require("../services/businessRuleService");
const c = require("../controllers/businessRuleController");
const { errorHandler } = require("../middleware/errorMiddleware");

const COMPANY = "64b000000000000000000001";
const OTHER = "64b000000000000000000002";

function appFor(companyId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { _id: "u1", companyId };
    next();
  });
  app.get("/rules", c.listRules);
  app.get("/rules/export.md", c.exportRules);
  app.post("/rules", c.createRule);
  app.patch("/rules/:id", c.updateRule);
  app.delete("/rules/:id", c.deleteRule);
  app.use(errorHandler);
  return app;
}

function fakeClient(json) {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(json) }] }),
    },
  };
}

const FILES = [{ filename: "routes/orders.js", status: "modified", patch: "+ if (order.shipped) throw 409" }];
const SCOPE = { owner: "acme", repo: "shop" };

beforeEach(() => {
  mockRules.length = 0;
});

describe("proposals from a merge", () => {
  test("are saved as proposed, with their evidence", async () => {
    const client = fakeClient({
      rules: [
        { kind: "state", text: "A shipped order cannot be cancelled", appliesTo: ["POST /orders/:id/cancel"], evidence: "orders.js" },
      ],
    });
    const saved = await rules.proposeFromDiff({
      companyId: COMPANY,
      scope: SCOPE,
      files: FILES,
      prNumber: 7,
      endpoints: ["POST /orders/:id/cancel"],
      anthropicClient: client,
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ status: "proposed", kind: "state", evidence: { prNumber: 7 } });
  });

  test("skip rules already on the list and endpoints that don't exist", async () => {
    mockRules.push({ companyId: COMPANY, ...SCOPE, status: "approved", text: "A shipped order cannot be cancelled", appliesTo: [] });
    const client = fakeClient({
      rules: [
        { kind: "state", text: "a shipped order  CANNOT be cancelled", appliesTo: [] },
        { kind: "nonsense", text: "Stock never goes below zero", appliesTo: ["GET /invented"] },
      ],
    });
    const saved = await rules.proposeFromDiff({
      companyId: COMPANY,
      scope: SCOPE,
      files: FILES,
      endpoints: ["POST /orders/:id/cancel"],
      anthropicClient: client,
    });
    expect(saved.map((r) => r.text)).toEqual(["Stock never goes below zero"]);
    expect(saved[0]).toMatchObject({ kind: "rule", appliesTo: [] });
  });

  test("an empty diff makes no model call", async () => {
    const client = fakeClient({ rules: [] });
    await rules.proposeFromDiff({ companyId: COMPANY, scope: SCOPE, files: [], anthropicClient: client });
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

describe("rules in test prompts", () => {
  const doc = { owner: "acme", repo: "shop", method: "post", path: "/orders/:id/cancel" };

  test("only approved rules for this endpoint or the whole API are used", async () => {
    mockRules.push(
      { companyId: COMPANY, ...SCOPE, status: "approved", kind: "state", text: "Shipped orders can't be cancelled", appliesTo: ["POST /orders/:id/cancel"] },
      { companyId: COMPANY, ...SCOPE, status: "approved", kind: "permission", text: "Guests can't write", appliesTo: [] },
      { companyId: COMPANY, ...SCOPE, status: "proposed", kind: "rule", text: "Unreviewed guess", appliesTo: [] },
      { companyId: COMPANY, ...SCOPE, status: "approved", kind: "rule", text: "About another endpoint", appliesTo: ["GET /users"] },
      { companyId: OTHER, ...SCOPE, status: "approved", kind: "rule", text: "Another company's rule", appliesTo: [] }
    );
    const note = rules.rulesNote(await rules.rulesFor({ companyId: COMPANY, doc }));
    expect(note).toContain("Shipped orders can't be cancelled");
    expect(note).toContain("Guests can't write");
    expect(note).not.toContain("Unreviewed guess");
    expect(note).not.toContain("About another endpoint");
    expect(note).not.toContain("Another company's rule");
  });

  test("no rules adds nothing to the prompt", async () => {
    expect(rules.rulesNote(await rules.rulesFor({ companyId: COMPANY, doc }))).toBe("");
  });
});

describe("reviewing rules", () => {
  test("approving a proposal records who did it", async () => {
    mockRules.push({ _id: "64b0000000000000000000a1", companyId: COMPANY, ...SCOPE, status: "proposed", text: "x", appliesTo: [] });
    const res = await request(appFor(COMPANY)).patch("/rules/64b0000000000000000000a1").send({ status: "approved" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "approved", reviewedBy: "u1" });
  });

  test("another company can't see, approve or delete it", async () => {
    mockRules.push({ _id: "64b0000000000000000000a1", companyId: COMPANY, ...SCOPE, status: "proposed", text: "x", appliesTo: [] });
    const app = appFor(OTHER);
    expect((await request(app).get("/rules")).body).toEqual([]);
    expect((await request(app).patch("/rules/64b0000000000000000000a1").send({ status: "approved" })).status).toBe(404);
    expect((await request(app).delete("/rules/64b0000000000000000000a1")).status).toBe(404);
    expect(mockRules[0].status).toBe("proposed");
  });

  test("a rule written by a person starts approved", async () => {
    const res = await request(appFor(COMPANY)).post("/rules").send({ ...SCOPE, kind: "invariant", text: "Stock never goes below zero" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "approved", source: "user" });
  });

  test("export lists only approved rules, grouped", async () => {
    mockRules.push(
      { companyId: COMPANY, ...SCOPE, status: "approved", kind: "permission", text: "Only owners delete projects", appliesTo: ["DELETE /projects/:id"] },
      { companyId: COMPANY, ...SCOPE, status: "rejected", kind: "rule", text: "Wrong guess", appliesTo: [] }
    );
    const res = await request(appFor(COMPANY)).get("/rules/export.md?owner=acme&repo=shop");
    expect(res.text).toContain("## Permissions");
    expect(res.text).toContain("- Only owners delete projects (DELETE /projects/:id)");
    expect(res.text).not.toContain("Wrong guess");
  });
});

describe("proposals from a PR's acceptance criteria", () => {
  test("each criterion the API can check is proposed once, never approved", async () => {
    mockRules.push({ companyId: COMPANY, ...SCOPE, status: "approved", text: "Returns 404 for a missing order", appliesTo: [] });
    const saved = await rules.proposeFromCriteria({
      companyId: COMPANY,
      scope: SCOPE,
      prNumber: 29,
      criteria: [
        { text: "Only the order's owner can see the invoice", endpoints: ["GET /orders/:id/invoice"], testable: "api" },
        { text: "returns 404 for a missing order", endpoints: [], testable: "api" },
        { text: "The invoice email looks right", endpoints: [], testable: "manual" },
      ],
    });
    expect(saved).toEqual([
      expect.objectContaining({
        text: "Only the order's owner can see the invoice",
        status: "proposed",
        appliesTo: ["GET /orders/:id/invoice"],
        evidence: expect.objectContaining({ prNumber: 29 }),
      }),
    ]);
  });
});
