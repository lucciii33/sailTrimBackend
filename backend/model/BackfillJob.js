const mongoose = require("mongoose");

const backfillJobSchema = new mongoose.Schema({
  installationId: { type: Number, required: true },
  owner: { type: String, required: true },
  repo: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  status: {
    type: String,
    enum: ["pending", "running", "completed", "failed"],
    default: "pending",
  },
  filesFound: { type: Number, default: 0 },
  filesProcessed: { type: Number, default: 0 },
  endpointsDetected: { type: Number, default: 0 },
  error: { type: String },
  startedAt: { type: Date },
  finishedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("BackfillJob", backfillJobSchema);
