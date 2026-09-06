const mongoose = require("mongoose");

const argumentSchema = new mongoose.Schema(
  {
    name: String,
    type: String,
    required: Boolean,
    description: String,
    default: mongoose.Schema.Types.Mixed,
    enum: [mongoose.Schema.Types.Mixed],
  },
  { _id: false }
);

const exampleSchema = new mongoose.Schema(
  {
    title: String,
    prompt: String,
    args: mongoose.Schema.Types.Mixed,
    expectedResult: String,
  },
  { _id: false }
);

const mcpDocSchema = new mongoose.Schema(
  {
    serverName: { type: String, required: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: "McpProject", index: true },
    serverUrl: { type: String },
    transport: {
      type: String,
      enum: ["stdio", "sse", "http"],
      default: "http",
    },
    toolName: { type: String, required: true },
    title: String,
    summary: String,
    description: String,
    inputSchema: mongoose.Schema.Types.Mixed,
    outputSchema: mongoose.Schema.Types.Mixed,
    inferredOutputSchema: mongoose.Schema.Types.Mixed,
    responseVerified: { type: Boolean, default: false },
    responseStatus: {
      type: String,
      enum: ["final", "unverified"],
      default: "unverified",
    },
    sampleArgs: mongoose.Schema.Types.Mixed,
    sampleResponse: mongoose.Schema.Types.Mixed,
    rawToolResponse: mongoose.Schema.Types.Mixed,
    responseExample: mongoose.Schema.Types.Mixed,
    responseSchema: mongoose.Schema.Types.Mixed,
    responseError: String,
    arguments: [argumentSchema],
    responseNotes: String,
    examples: [exampleSchema],
    risks: [String],
    rawTool: mongoose.Schema.Types.Mixed,
    tags: [String],
    generatedBy: {
      provider: { type: String, enum: ["openai", "anthropic", "none"], default: "none" },
      model: String,
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  },
  { timestamps: true }
);

mcpDocSchema.index({
  companyId: 1,
  projectId: 1,
  serverUrl: 1,
  transport: 1,
  toolName: 1,
});

module.exports = mongoose.model("McpDoc", mcpDocSchema);
