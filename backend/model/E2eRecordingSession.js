const mongoose = require("mongoose");

// One cloud-recording session: the customer opened the embedded browser and is
// (or was) recording a flow for a specific test. Events stream in from the
// injected recorder via /ingest; on finish they're converted to a Playwright
// spec and saved onto the test. tokenHash ties incoming events to this row
// without exposing the raw token in the DB.
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
  testId: { type: mongoose.Schema.Types.ObjectId, ref: "E2eTest", required: true, index: true },
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
