const mongoose = require("mongoose");

// Olivia's QA review of one merged pull request: the tests it wrote against
// what changed, what happened when they ran, its verdict, and the questions it
// couldn't answer alone. A person reads it and makes the actual decision.
const TEST_TYPES = ["functional", "business_rule", "boundary", "security", "regression"];
const VERDICTS = ["pass", "fail", "review"];

const testSchema = new mongoose.Schema(
  {
    type: { type: String, enum: TEST_TYPES, default: "functional" },
    endpoint: String,
    name: String,
    covers: String,
    expectedStatus: { type: [Number], default: [] },
    passed: Boolean,
    reason: String,
    // Evidence. Credentials are removed before saving: this is shown in the PR.
    request: {
      method: String,
      url: String,
      headers: mongoose.Schema.Types.Mixed,
      body: mongoose.Schema.Types.Mixed,
    },
    response: {
      status: Number,
      durationMs: Number,
      body: mongoose.Schema.Types.Mixed,
      error: String,
    },
  },
  { _id: true }
);

const questionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    endpoint: { type: String, default: "" },
    answer: { type: String, default: "" },
    answeredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    answeredAt: { type: Date, default: null },
    // The approved rule the answer became, so the next PR already knows it.
    ruleId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessRule", default: null },
  },
  { _id: true }
);

const prReviewSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    watcherId: { type: mongoose.Schema.Types.ObjectId, ref: "ApiWatcher" },
    owner: { type: String, required: true },
    repo: { type: String, required: true },
    branch: { type: String, default: "" },
    prNumber: { type: Number, required: true },
    prTitle: { type: String, default: "" },

    status: { type: String, enum: ["running", "done", "failed"], default: "running" },
    error: { type: String, default: "" },
    verdict: { type: String, enum: [...VERDICTS, null], default: null },
    verdictReason: { type: String, default: "" },
    tests: { type: [testSchema], default: [] },
    questions: { type: [questionSchema], default: [] },
    commentUrl: { type: String, default: "" },

    // The person's call, separate from Olivia's verdict.
    decision: { type: String, enum: ["approved", "rejected", null], default: null },
    decisionNote: { type: String, default: "" },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

prReviewSchema.index({ companyId: 1, owner: 1, repo: 1, createdAt: -1 });

module.exports = mongoose.model("PrReview", prReviewSchema);
module.exports.TEST_TYPES = TEST_TYPES;
