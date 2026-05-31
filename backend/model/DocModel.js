const mongoose = require("mongoose");

const paramSchema = new mongoose.Schema(
  {
    name: String,
    type: String,
    required: Boolean,
    description: String,
  },
  { _id: false }
);

const responseSchema = new mongoose.Schema(
  {
    status: Number,
    description: String,
    example: mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const docSchema = new mongoose.Schema({
  method: { type: String, required: true },
  path: { type: String, required: true },
  section: { type: String, default: "default" },
  description: { type: String, required: true },
  requestBody: [paramSchema],
  queryParams: [paramSchema],
  responses: [responseSchema],
  prNumber: { type: Number },
  // Spec-import endpoints belong to an ApiProject instead of a GitHub repo.
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ApiProject",
    index: true,
  },
  // owner/repo are only required for the GitHub-docs flow; spec imports leave
  // them empty and key off projectId.
  repo: { type: String },
  owner: { type: String },
  source: { type: String, enum: ["pr", "backfill"], default: "pr" },
  sourceFile: { type: String },
  sourceSha: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
});

docSchema.index({ companyId: 1, owner: 1, repo: 1 });

module.exports = mongoose.model("Doc", docSchema);
