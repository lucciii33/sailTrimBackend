const mongoose = require("mongoose");

const mcpProjectSchema = new mongoose.Schema(
  {
    projectName: { type: String, required: true },
    name: { type: String, required: true },
    config: { type: mongoose.Schema.Types.Mixed, required: true },
    configEncrypted: { type: String },
    resources: [mongoose.Schema.Types.Mixed],
    prompts: [mongoose.Schema.Types.Mixed],
    lastConnectedAt: Date,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  },
  { timestamps: true }
);

mcpProjectSchema.index({ companyId: 1, projectName: 1 }, { unique: true });

module.exports = mongoose.model("McpProject", mcpProjectSchema);
