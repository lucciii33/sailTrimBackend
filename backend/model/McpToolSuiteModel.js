const mongoose = require("mongoose");

// One generated test for a single MCP tool.
//
// `covers` is a plain sentence saying what the test verifies, shown in the tests
// page and editable from there. The machine-checkable part is `assertions`,
// judged against the tool's actual response.
const mcpToolCaseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  covers: { type: String, default: "" },
  // happy_path | missing_required | wrong_type | boundary | error_handling
  category: { type: String, default: "happy_path" },

  // Arguments the tool is invoked with. Must validate against its inputSchema.
  args: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Plain-English checks on the response, evaluated by the model at run time.
  assertions: { type: [String], default: [] },

  // Whether the call is expected to succeed. An error-handling case expects the
  // tool to REJECT the input, so "it threw" is a pass, not a failure.
  expectError: { type: Boolean, default: false },

  // Recorded on the first green run and compared on later ones — that's what
  // makes a regression suite catch behaviour that changed.
  baseline: {
    isError: { type: Boolean, default: null },
    resultKeys: { type: [String], default: [] },
    recordedAt: { type: Date, default: null },
  },
});

// A suite = the tests for ONE tool, of ONE kind.
//
// Per-tool, not per-project like the older McpSuite. That model generated every
// tool's cases in a single LLM call capped at 4096 output tokens: fine for three
// tools, truncated at forty, impossible at two hundred. One call per tool has no
// such ceiling, and a tool that fails to generate no longer takes the whole
// project's suite down with it.
const mcpToolSuiteSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "McpProject",
      required: true,
      index: true,
    },
    toolName: { type: String, required: true, index: true },
    // Denormalised so the tests page can group without loading every tool.
    group: { type: String, default: "general", index: true },

    kind: {
      type: String,
      enum: ["smoke", "regression"],
      required: true,
      index: true,
    },

    cases: { type: [mcpToolCaseSchema], default: [] },

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

// One suite per tool per kind — regenerating replaces it instead of piling up.
mcpToolSuiteSchema.index({ projectId: 1, toolName: 1, kind: 1 }, { unique: true });
mcpToolSuiteSchema.index({ companyId: 1, projectId: 1, group: 1 });

module.exports = mongoose.model("McpToolSuite", mcpToolSuiteSchema);
