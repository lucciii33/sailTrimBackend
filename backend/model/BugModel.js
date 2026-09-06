const mongoose = require("mongoose");

const requestSchema = new mongoose.Schema(
  {
    method: String,
    url: String,
    headers: { type: Map, of: String },
    body: mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const responseSchema = new mongoose.Schema(
  {
    status: Number,
    durationMs: Number,
    headers: { type: Map, of: String },
    body: mongoose.Schema.Types.Mixed,
    error: String,
  },
  { _id: false }
);

const bugSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    index: true,
  },
  docId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Doc",
    required: true,
  },
  owner: { type: String },
  repo: { type: String },
  runId: { type: String, required: true, index: true },
  severity: {
    type: String,
    enum: ["low", "medium", "high", "critical"],
    default: "medium",
  },
  category: { type: String, default: "general" },
  title: { type: String, required: true },
  description: { type: String, default: "" },
  testCaseName: { type: String, default: "" },
  expectedStatus: [Number],
  request: requestSchema,
  response: responseSchema,
  status: {
    type: String,
    enum: ["open", "ignored", "fixed"],
    default: "open",
  },
  createdAt: { type: Date, default: Date.now },
});

bugSchema.index({ companyId: 1, docId: 1, createdAt: -1 });

module.exports = mongoose.model("Bug", bugSchema);
