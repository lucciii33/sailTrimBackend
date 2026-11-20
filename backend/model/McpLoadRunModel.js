const mongoose = require("mongoose");

/** Latency distribution for a set of samples (ms). */
const latencySchema = {
  min: Number,
  p50: Number,
  p90: Number,
  p95: Number,
  p99: Number,
  max: Number,
  avg: Number,
};

/** Per-tool aggregate under load. */
const toolLoadSchema = new mongoose.Schema(
  {
    toolName: { type: String, required: true },
    weight: { type: Number, default: 1 },
    requests: { type: Number, default: 0 },
    ok: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    errorRatePct: { type: Number, default: 0 },
    throughputRps: { type: Number, default: 0 },
    latencyMs: latencySchema,
    avgResponseBytes: { type: Number, default: 0 },
    firstError: String,
    args: mongoose.Schema.Types.Mixed,
  },
  { _id: false },
);

/** One time bucket (per second) for charting throughput/latency over the run. */
const timeBucketSchema = new mongoose.Schema(
  {
    t: Number, // seconds since start
    activeVUs: Number,
    requests: Number,
    failed: Number,
    p95Ms: Number,
    rps: Number,
  },
  { _id: false },
);

/** Evaluation of a single tester-defined threshold. */
const thresholdResultSchema = new mongoose.Schema(
  {
    metric: String, // p95Ms | p99Ms | errorRatePct | minThroughputRps | maxAvgResponseBytes
    op: String, // "<=" | ">="
    target: Number,
    actual: Number,
    passed: Boolean,
  },
  { _id: false },
);

const mcpLoadRunSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "McpProject",
      index: true,
    },
    serverName: { type: String, required: true },
    serverUrl: String,
    transport: {
      type: String,
      enum: ["stdio", "sse", "http"],
      default: "http",
    },

    // --- what the tester configured ---
    testType: {
      type: String,
      enum: ["load", "stress", "spike", "soak", "custom"],
      default: "load",
    },
    // Ramp schedule: [{ target: <VUs>, durationSec: <n> }, ...]
    stages: [
      {
        target: Number,
        durationSec: Number,
        _id: false,
      },
    ],
    selectedTools: [String],
    peakVUs: Number,
    totalDurationSec: Number,
    thresholds: mongoose.Schema.Types.Mixed, // raw tester input

    // --- results ---
    summary: {
      totalRequests: Number,
      okRequests: Number,
      failedRequests: Number,
      errorRatePct: Number,
      throughputRps: Number,
      latencyMs: latencySchema,
      actualDurationSec: Number,
      peakVUs: Number,
    },
    thresholdResults: [thresholdResultSchema],
    verdict: {
      type: String,
      enum: ["pass", "fail", "no-thresholds"],
      default: "no-thresholds",
    },
    notes: [String],
    tools: [toolLoadSchema],
    timeSeries: [timeBucketSchema],

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      index: true,
    },
  },
  { timestamps: true },
);

mcpLoadRunSchema.index({ companyId: 1, projectId: 1, createdAt: -1 });

module.exports = mongoose.model("McpLoadRun", mcpLoadRunSchema);
