const mongoose = require("mongoose");

// What the team knows about how their API is supposed to behave: "a member
// can't delete a project", "an order can't be cancelled once shipped". Olivia
// reads the approved ones before writing tests, so every later ticket is
// checked against what earlier tickets established.
//
// The logic only, never the code. `evidence` says where a rule came from so a
// reviewer can check it.
//
// Rules Olivia proposes stay "proposed" until a person approves them. A rule
// the model made up and nobody checked would turn into bug reports for
// behaviour that is correct.
const KINDS = ["rule", "permission", "state", "invariant", "known_bug"];
const STATUSES = ["proposed", "approved", "rejected"];

const businessRuleSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    // A connected repo (owner + repo) or an imported API project.
    owner: { type: String, default: "" },
    repo: { type: String, default: "" },
    projectId: { type: mongoose.Schema.Types.ObjectId, default: null },

    kind: { type: String, enum: KINDS, default: "rule" },
    text: { type: String, required: true, trim: true, maxlength: 500 },
    // "METHOD /path" keys it is about. Empty means it applies to the whole API.
    appliesTo: { type: [String], default: [] },

    status: { type: String, enum: STATUSES, default: "proposed", index: true },
    source: { type: String, enum: ["olivia", "user"], default: "olivia" },
    evidence: {
      prNumber: { type: Number, default: null },
      files: { type: [String], default: [] },
      note: { type: String, default: "" },
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

businessRuleSchema.index({ companyId: 1, owner: 1, repo: 1, status: 1 });
businessRuleSchema.index({ companyId: 1, projectId: 1, status: 1 });

module.exports = mongoose.model("BusinessRule", businessRuleSchema);
module.exports.KINDS = KINDS;
module.exports.STATUSES = STATUSES;
