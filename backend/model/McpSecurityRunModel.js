const mongoose = require("mongoose");

const findingSchema = new mongoose.Schema(
  {
    probe: { type: String, required: true },
    toolName: { type: String, required: true },
    category: {
      type: String,
      enum: [
        "prompt_injection",
        "tool_poisoning",
        "sql_injection",
        "nosql_injection",
        "command_injection",
        "path_traversal",
        "ssrf",
        "xss",
        "auth_bypass",
        "secret_leakage",
        "schema_bypass",
        "unbounded_response",
      ],
      required: true,
    },
    severity: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },
    title: { type: String, required: true },
    description: String,
    field: String,
    payload: mongoose.Schema.Types.Mixed,
    args: mongoose.Schema.Types.Mixed,
    response: mongoose.Schema.Types.Mixed,
    evidence: String,
    recommendation: String,
    bugId: { type: mongoose.Schema.Types.ObjectId, ref: "McpBug" },
  },
  { _id: false }
);

const mcpSecurityRunSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: "McpProject", index: true },
    serverName: { type: String, required: true },
    serverUrl: String,
    transport: {
      type: String,
      enum: ["stdio", "sse", "http"],
      default: "http",
    },
    summary: {
      totalTools: Number,
      probesRun: Number,
      findings: Number,
      bySeverity: {
        critical: Number,
        high: Number,
        medium: Number,
        low: Number,
      },
      byCategory: mongoose.Schema.Types.Mixed,
    },
    findings: [findingSchema],
    bugIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "McpBug" }],
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  },
  { timestamps: true }
);

mcpSecurityRunSchema.index({ companyId: 1, projectId: 1, createdAt: -1 });

module.exports = mongoose.model("McpSecurityRun", mcpSecurityRunSchema);
