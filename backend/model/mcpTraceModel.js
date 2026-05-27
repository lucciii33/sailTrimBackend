const mongoose = require("mongoose");

/**
 * A trace = one full execution: a user prompt -> tool selection -> tool call -> judge verdict.
 * Inspired by LangSmith "runs", but tailored to MCP (tool schemas, MCP server metadata, judge verdicts).
 */
const mcpTraceSchema = new mongoose.Schema(
  {
    // --- MCP server identity ---
    serverName: { type: String, required: true },
    serverUrl: { type: String }, // for HTTP/SSE transport
    transport: {
      type: String,
      enum: ["stdio", "sse", "http"],
      default: "http",
    },

    // --- Input ---
    userPrompt: { type: String }, // the human query (optional: direct tool calls skip this)
    toolName: { type: String, required: true },
    toolArgs: { type: mongoose.Schema.Types.Mixed },
    toolSchema: { type: mongoose.Schema.Types.Mixed }, // snapshot of the tool's schema when called

    // --- Execution ---
    model: { type: String }, // which LLM picked the tool (gpt-4o, claude-sonnet-4-6, none)
    provider: {
      type: String,
      enum: ["openai", "anthropic", "none"],
      default: "none",
    },
    toolResponse: { type: mongoose.Schema.Types.Mixed },
    rawResponse: { type: mongoose.Schema.Types.Mixed }, // full LLM message for debugging
    latencyMs: { type: Number },
    error: { type: String },
    status: {
      type: String,
      enum: ["ok", "error", "timeout"],
      default: "ok",
    },

    // --- Judge (LLM-as-Judge) ---
    judge: {
      provider: { type: String, enum: ["openai", "anthropic"] },
      model: { type: String },
      score: { type: Number, min: 0, max: 10 },
      verdict: { type: String, enum: ["pass", "fail", "warn"] },
      reasoning: { type: String },
      suggestions: [{ type: String }],
      raw: { type: mongoose.Schema.Types.Mixed },
    },

    // --- Comparison mode (MCP vs direct API) ---
    comparison: {
      apiUrl: { type: String },
      apiResponse: { type: mongoose.Schema.Types.Mixed },
      divergence: { type: String }, // judge-generated summary
      matchScore: { type: Number, min: 0, max: 10 },
    },

    // --- Tags for filtering ---
    suiteId: { type: mongoose.Schema.Types.ObjectId, ref: "McpSuite" },
    tags: [{ type: String }],

    // --- Ownership ---
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  },
  { timestamps: true }
);

mcpTraceSchema.index({ companyId: 1, createdAt: -1 });
mcpTraceSchema.index({ companyId: 1, serverName: 1, createdAt: -1 });

/**
 * A Suite = a collection of test cases you run against an MCP server.
 */
const mcpSuiteSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String },
    serverName: { type: String, required: true },
    serverUrl: { type: String },
    transport: { type: String, default: "http" },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: "McpProject", index: true },
    kind: { type: String, enum: ["manual", "smoke", "regression"], default: "manual", index: true },
    generatedBy: {
      provider: { type: String, enum: ["openai", "anthropic", "none"], default: "none" },
      model: String,
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
    cases: [
      {
        name: String,
        userPrompt: String,
        expectedTool: String,
        expectedArgs: mongoose.Schema.Types.Mixed,
        expectedResponse: mongoose.Schema.Types.Mixed, // baseline response for regression checks
        assertions: [String], // plain english, judge evaluates
      },
    ],
  },
  { timestamps: true }
);

mcpSuiteSchema.index({ companyId: 1, projectId: 1, kind: 1 });

const McpTrace = mongoose.model("McpTrace", mcpTraceSchema);
const McpSuite = mongoose.model("McpSuite", mcpSuiteSchema);

module.exports = { McpTrace, McpSuite };
