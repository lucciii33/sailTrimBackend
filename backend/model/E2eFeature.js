const mongoose = require("mongoose");

// A Feature groups test cases inside a project. Hierarchy:
//   E2eProject (url + repo + name + ONE login)
//     └─ E2eFeature (a named area of the app, e.g. "Checkout", "Dashboard")
//          └─ E2eTest (the individual cases, born from a video drop)
// The demo video is uploaded PER FEATURE: drop a video on a feature → Whisper
// transcribes it → the generated test cases land under that feature.
const e2eFeatureSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    index: true,
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "E2eProject",
    required: true,
    index: true,
  },
  name: { type: String, required: true },
  description: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

e2eFeatureSchema.index({ companyId: 1, projectId: 1, createdAt: -1 });

module.exports = mongoose.model("E2eFeature", e2eFeatureSchema);
