const mongoose = require("mongoose");

const mcpUsageEventSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: ["docs_generate", "qa_run", "smoke_generate", "smoke_run"],
      required: true,
      index: true,
    },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: "McpProject", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  },
  { timestamps: true }
);

mcpUsageEventSchema.index({ companyId: 1, action: 1, createdAt: -1 });

module.exports = mongoose.model("McpUsageEvent", mcpUsageEventSchema);
