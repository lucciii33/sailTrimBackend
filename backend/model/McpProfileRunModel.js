const mongoose = require("mongoose");

const toolProfileSchema = new mongoose.Schema(
  {
    toolName: { type: String, required: true },
    status: { type: String, enum: ["ok", "error", "skipped"], default: "ok" },
    error: String,
    runs: { type: Number, default: 0 },
    latencyMs: {
      min: Number,
      p50: Number,
      p95: Number,
      max: Number,
      avg: Number,
    },
    responseBytes: {
      min: Number,
      avg: Number,
      max: Number,
    },
    estimatedTokens: {
      input: Number,
      output: Number,
      total: Number,
    },
    contextRiskPct: Number,
    contextRiskLevel: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "low",
    },
    args: mongoose.Schema.Types.Mixed,
    sampleResponse: mongoose.Schema.Types.Mixed,
    notes: [String],
  },
  { _id: false }
);

const mcpProfileRunSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: "McpProject", index: true },
    serverName: { type: String, required: true },
    serverUrl: String,
    transport: {
      type: String,
      enum: ["stdio", "sse", "http"],
      default: "http",
    },
    contextWindow: { type: Number, default: 200000 },
    iterationsPerTool: { type: Number, default: 3 },
    summary: {
      totalTools: Number,
      profiledTools: Number,
      failedTools: Number,
      totalEstimatedTokens: Number,
      heaviestTool: String,
      heaviestToolTokens: Number,
      slowestTool: String,
      slowestToolP95Ms: Number,
      contextBombs: Number,
    },
    tools: [toolProfileSchema],
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  },
  { timestamps: true }
);

mcpProfileRunSchema.index({ companyId: 1, projectId: 1, createdAt: -1 });

module.exports = mongoose.model("McpProfileRun", mcpProfileRunSchema);
