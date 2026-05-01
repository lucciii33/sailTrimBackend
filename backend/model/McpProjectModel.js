const mongoose = require("mongoose");

const mcpProjectSchema = new mongoose.Schema(
  {
    projectName: { type: String, required: true },
    name: { type: String, required: true },
    config: { type: mongoose.Schema.Types.Mixed, required: true },
    resources: [mongoose.Schema.Types.Mixed],
    prompts: [mongoose.Schema.Types.Mixed],
    lastConnectedAt: Date,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

mcpProjectSchema.index({ userId: 1, projectName: 1 });

module.exports = mongoose.model("McpProject", mcpProjectSchema);
