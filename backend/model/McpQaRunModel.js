const mongoose = require("mongoose");

const mcpQaRunSchema = new mongoose.Schema(
  {
    serverName: { type: String, required: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: "McpProject", index: true },
    serverUrl: { type: String },
    transport: {
      type: String,
      enum: ["stdio", "sse", "http"],
      default: "http",
    },
    summary: {
      total: Number,
      passed: Number,
      failed: Number,
      warned: Number,
      bugs: Number,
    },
    cases: [mongoose.Schema.Types.Mixed],
    results: [mongoose.Schema.Types.Mixed],
    bugs: [mongoose.Schema.Types.Mixed],
    generatedBy: {
      provider: { type: String, enum: ["openai", "anthropic", "none"], default: "none" },
      model: String,
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  },
  { timestamps: true }
);

mcpQaRunSchema.index({ companyId: 1, serverName: 1, createdAt: -1 });
mcpQaRunSchema.index({ companyId: 1, projectId: 1, createdAt: -1 });

module.exports = mongoose.model("McpQaRun", mcpQaRunSchema);
