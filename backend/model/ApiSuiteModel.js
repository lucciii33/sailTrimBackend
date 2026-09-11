const mongoose = require("mongoose");

// One generated test for a single endpoint.
//
// `covers` is the whole point of the feature: a plain sentence saying what this
// test actually verifies, shown in the tests page and editable from there. The
// machine-checkable part lives in `expectedStatus` + `assertions`.
const apiTestCaseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  // What this test verifies, in one human sentence. Written by the generator,
  // rewritten by the refiner when the user asks to cover more.
  covers: { type: String, default: "" },
  // happy_path | not_found | unauthorized | invalid_input | boundary | security
  category: { type: String, default: "happy_path" },

  // The request. Mirrors what executeTestCase() in apiQAService expects, so the
  // runner is the same code path the bug hunter already uses.
  method: { type: String, default: "" }, // "" → inherit the endpoint's method
  path: { type: String, default: "" }, // "" → inherit the endpoint's path
  headers: { type: mongoose.Schema.Types.Mixed, default: null },
  body: { type: mongoose.Schema.Types.Mixed, default: null },
  expectedStatus: { type: [Number], default: [] },

  // Plain-English checks on the response, evaluated by Claude at run time.
  // Same idea as the MCP suites: readable by a QA lead, not just by code.
  assertions: { type: [String], default: [] },

  // Filled on the first successful run and compared on later ones — that's
  // what makes a regression suite a regression suite rather than a re-run.
  baseline: {
    status: { type: Number, default: null },
    bodyKeys: { type: [String], default: [] },
    recordedAt: { type: Date, default: null },
  },
});

// A suite = the tests for ONE endpoint, of ONE kind.
//
// Per-endpoint (not per-project like the MCP suites) because the tests page is
// organised section → endpoint → tests, and the Create test button lives on the
// endpoint row.
const apiSuiteSchema = new mongoose.Schema(
  {
    // An endpoint belongs EITHER to an imported spec (projectId) or to a
    // connected GitHub repo (owner/repo) — the Doc model works the same way.
    // Exactly one of the two is set, so neither can be required.
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ApiProject",
      default: null,
      index: true,
    },
    owner: { type: String, default: "" },
    repo: { type: String, default: "" },
    docId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doc",
      required: true,
      index: true,
    },
    // Denormalised from the Doc so the tests page can group without loading
    // every endpoint. Kept in sync whenever the suite is regenerated.
    section: { type: String, default: "default", index: true },
    method: { type: String, default: "" },
    path: { type: String, default: "" },

    // smoke      = one happy path, "is this endpoint alive?"
    // regression = the full set, re-run to catch behaviour that changed
    kind: {
      type: String,
      enum: ["smoke", "regression"],
      required: true,
      index: true,
    },

    cases: { type: [apiTestCaseSchema], default: [] },

    generatedBy: {
      provider: { type: String, default: "anthropic" },
      model: { type: String, default: "" },
    },

    lastRun: {
      at: { type: Date, default: null },
      passed: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      regressions: { type: Number, default: 0 },
    },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

// One suite per endpoint per kind — regenerating replaces it rather than
// piling up copies.
apiSuiteSchema.index({ docId: 1, kind: 1 }, { unique: true });
apiSuiteSchema.index({ companyId: 1, projectId: 1, section: 1 });
apiSuiteSchema.index({ companyId: 1, owner: 1, repo: 1, section: 1 });

module.exports = mongoose.model("ApiSuite", apiSuiteSchema);
