const mongoose = require("mongoose");

const requestSchema = new mongoose.Schema(
  { method: String, url: String, headers: { type: Map, of: String }, body: mongoose.Schema.Types.Mixed },
  { _id: false }
);

const responseSchema = new mongoose.Schema(
  { status: Number, durationMs: Number, headers: { type: Map, of: String }, body: mongoose.Schema.Types.Mixed, error: String },
  { _id: false }
);

const executionSchema = new mongoose.Schema(
  {
    name: String,
    group: String,
    category: String,
    rationale: String,
    stepIndex: Number,
    targetMethod: String,
    targetPath: String,
    expectedStatus: [Number],
    request: requestSchema,
    response: responseSchema,
    isBug: { type: Boolean, default: false },
    bugTitle: String,
    bugDescription: String,
    bugSeverity: String,
    bugCategory: String,
  },
  { _id: false }
);

const suiteRunSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "ApiProject", index: true },
  section:   { type: String, required: true },
  runId:     { type: String, required: true, unique: true },
  totalTests: Number,
  bugCount:   Number,
  executions: [executionSchema],
  createdAt:  { type: Date, default: Date.now },
});

suiteRunSchema.index({ companyId: 1, projectId: 1, section: 1, createdAt: -1 });

module.exports = mongoose.model("SuiteRun", suiteRunSchema);
