const mongoose = require("mongoose");

const mcpToolSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "McpProject",
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    description: String,
    inputSchema: mongoose.Schema.Types.Mixed,
    outputSchema: mongoose.Schema.Types.Mixed,
    rawTool: mongoose.Schema.Types.Mixed,
    suggestedArgs: mongoose.Schema.Types.Mixed,
    suggestedArgsGeneratedAt: Date,
    // Flagged by the MCP watcher when a tool shows up on the live server after a
    // merge that wasn't there before. Cleared once someone has reviewed it.
    // NOT `isNew`: mongoose reserves that name for its own "unsaved" flag.
    isNewTool: { type: Boolean, default: false, index: true },
    firstSeenAt: { type: Date, default: null },
    firstSeenPr: { type: Number, default: null },
    // Set by the MCP watcher when a merge changed this tool's input or output
    // schema. The tool record is already updated, but its DOC is not — doc
    // generation calls the tool with real data, which the watcher won't do on
    // its own. So the UI asks a person to update it, and regenerating the doc
    // clears the flag.
    hasPendingChanges: { type: Boolean, default: false, index: true },
    pendingChanges: { type: [String], default: [] },
    lastEditedAt: { type: Date, default: null },
    lastEditedPr: { type: Number, default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  },
  { timestamps: true }
);

mcpToolSchema.index({ projectId: 1, name: 1 }, { unique: true });
mcpToolSchema.index({ companyId: 1, projectId: 1 });

module.exports = mongoose.model("McpTool", mcpToolSchema);
