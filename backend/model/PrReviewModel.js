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
    // Couldn't run: it needs data Olivia doesn't have. Never invented, never
    // counted as a failure.
    blocked: { type: Boolean, default: false },
    needs: { type: String, default: "" },
    // Written by the first review, or later in the chat with the agent.
    source: { type: String, enum: ["review", "chat"], default: "review" },
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

// Something the agent wants to keep, waiting for the user's yes.
const actionSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["save_variable", "save_rule"], required: true },
    key: { type: String, default: "" },
    value: { type: String, default: "" },
    ruleKind: { type: String, default: "rule" },
    ruleText: { type: String, default: "" },
    endpoint: { type: String, default: "" },
    why: { type: String, default: "" },
    status: { type: String, enum: ["pending", "applied", "dismissed"], default: "pending" },
  },
  { _id: true }
);

const chatMessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "agent"], required: true },
    text: { type: String, default: "" },
    at: { type: Date, default: Date.now },
    actions: { type: [actionSchema], default: [] },
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
    // The conversation with the agent about this review.
    chat: { type: [chatMessageSchema], default: [] },

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
