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
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  },
  { timestamps: true }
);

mcpToolSchema.index({ projectId: 1, name: 1 }, { unique: true });
mcpToolSchema.index({ companyId: 1, projectId: 1 });

module.exports = mongoose.model("McpTool", mcpToolSchema);
