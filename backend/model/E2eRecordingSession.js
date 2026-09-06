const mongoose = require("mongoose");

// One cloud-browser session the customer is driving from the embedded live
// view. Two kinds share this row (see `kind`):
//   recording — a flow for a specific test. Events stream in from the injected
//               recorder via /ingest; on finish they become a Playwright spec.
//   login     — a one-time login capture for the project. No recorder is
//               injected and no events arrive; on finish we read the browser's
//               storageState and save it as the project's session.
// tokenHash ties incoming events to this row without exposing the raw token in
// the DB (a login row carries an unused one, since the column is unique).
const recordedEventSchema = new mongoose.Schema(
  {
    type: { type: String }, // navigate | click | fill
    url: { type: String, default: "" },
    title: { type: String, default: "" },
    selector: { type: String, default: "" },
    testId: { type: String, default: null },
    role: { type: String, default: "" },
    text: { type: String, default: "" },
    value: { type: String, default: "" },
    sensitive: { type: Boolean, default: false },
    ts: { type: Number, default: 0 },
  },
  { _id: false }
);

const e2eRecordingSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "E2eProject", required: true, index: true },
  // "recording" = grabbing a flow for one test (has testId, streams events).
  // "login"     = capturing the project's authenticated session in the same
  //               embedded browser; project-level, so no testId and no events.
  kind: { type: String, enum: ["recording", "login"], default: "recording", index: true },
  // Required for kind "recording" only — a login capture belongs to the
  // project, not to any single test.
  testId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "E2eTest",
    index: true,
    required: function () {
      return this.kind !== "login";
    },
  },
  envName: { type: String, default: "" },

  tokenHash: { type: String, required: true, unique: true },
  browserbaseSessionId: { type: String, default: "" },
  liveViewUrl: { type: String, default: "" },

  status: {
    type: String,
    enum: ["recording", "finished", "cancelled", "error"],
    default: "recording",
  },
  events: { type: [recordedEventSchema], default: [] },

  startedAt: { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null },
  lastEventAt: { type: Date, default: null },
});

e2eRecordingSessionSchema.index({ testId: 1, status: 1, startedAt: -1 });

module.exports = mongoose.model("E2eRecordingSession", e2eRecordingSessionSchema);
