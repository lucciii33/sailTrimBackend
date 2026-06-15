const mongoose = require("mongoose");

// A BDD scenario in Given/When/Then form — the "test case" surfaced in
// Feature 1 (video → cases). Each line is a short human step.
const gherkinSchema = new mongoose.Schema(
  {
    feature: { type: String, default: "" },
    scenario: { type: String, default: "" },
    given: { type: [String], default: [] },
    when: { type: [String], default: [] },
    then: { type: [String], default: [] },
  },
  { _id: false }
);

// One recorded user action captured by the in-app recorder (Feature 2). Kept
// structured (not prose) so Claude transcribes exact selectors instead of
// guessing — testId is the real data-testid when present, else null (flagged
// as a missing-testid task for devs).
const actionSchema = new mongoose.Schema(
  {
    type: { type: String }, // click | fill | press | navigate | expect
    testId: { type: String, default: null },
    role: { type: String, default: "" },
    text: { type: String, default: "" },
    value: { type: String, default: "" },
    url: { type: String, default: "" },
  },
  { _id: false }
);

// One pass of the self-healing loop (Feature 2): the spec tried, whether it
// passed, and the captured error/trace fed back to Claude.
const healIterationSchema = new mongoose.Schema(
  {
    attempt: { type: Number },
    passed: { type: Boolean, default: false },
    error: { type: String, default: "" },
    durationMs: { type: Number },
  },
  { _id: false }
);

// A single E2E test. Born as a draft from a video (Feature 1: gherkin filled,
// status "draft"), then in Feature 2 it gets a recording + generated spec, runs
// through the heal loop until green, and is committed to the project's branch.
const e2eTestSchema = new mongoose.Schema({
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
  source: { type: String, enum: ["video", "recording"], default: "video" },
  kind: {
    type: String,
    enum: ["smoke", "regression", "bughunt"],
    default: "regression",
  },
  gherkin: { type: gherkinSchema, default: () => ({}) },

  // Video-source provenance.
  transcript: { type: String, default: "" },
  videoUrl: { type: String, default: "" },
  videoKey: { type: String, default: "" },

  // Feature 2 fields (recorder + heal loop + commit).
  recordedActions: { type: [actionSchema], default: [] },
  specCode: { type: String, default: "" },
  specPath: { type: String, default: "" },
  heal: { type: [healIterationSchema], default: [] },
  commit: {
    type: new mongoose.Schema(
      {
        branch: String,
        sha: String,
        url: String,
        committedAt: Date,
      },
      { _id: false }
    ),
    default: () => ({}),
  },

  status: {
    type: String,
    enum: ["draft", "recording", "generating", "passing", "failing", "committed", "error"],
    default: "draft",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

e2eTestSchema.index({ companyId: 1, projectId: 1, createdAt: -1 });

module.exports = mongoose.model("E2eTest", e2eTestSchema);
