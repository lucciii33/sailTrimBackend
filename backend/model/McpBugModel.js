const mongoose = require("mongoose");

const mcpBugSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: "McpProject", index: true },
    toolId: { type: mongoose.Schema.Types.ObjectId, ref: "McpTool", index: true },
    docId: { type: mongoose.Schema.Types.ObjectId, ref: "McpDoc", index: true },
    qaRunId: { type: mongoose.Schema.Types.ObjectId, ref: "McpQaRun", index: true },
    serverName: { type: String, required: true },
    serverUrl: String,
    transport: {
      type: String,
      enum: ["stdio", "sse", "http"],
      default: "http",
    },
    toolName: { type: String, required: true, index: true },
    testCaseName: String,
    severity: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },
    category: { type: String, default: "general" },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    expected: String,
    actual: String,
    evidence: String,
    recommendation: String,
    args: mongoose.Schema.Types.Mixed,
    response: mongoose.Schema.Types.Mixed,
    rawToolResponse: mongoose.Schema.Types.Mixed,
    status: {
      type: String,
      enum: ["open", "ignored", "fixed"],
      default: "open",
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  },
  { timestamps: true }
);

mcpBugSchema.index({ companyId: 1, projectId: 1, status: 1, createdAt: -1 });
mcpBugSchema.index({ companyId: 1, toolName: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("McpBug", mcpBugSchema);
