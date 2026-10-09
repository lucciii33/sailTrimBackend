const mongoose = require("mongoose");

// One long-running piece of work, tracked so the browser doesn't have to hold a
// request open while it happens.
//
// Generating docs already worked this way (BackfillJob). Running a test suite
// and hunting bugs did not: the HTTP request stayed open for the minutes they
// take, so the page sat there and a customer could only do one thing at a time.
// This is the same trick, generalised: POST returns a job id, the page polls it,
// and several can run at once up to the plan's limit.
const jobSchema = new mongoose.Schema(
  {
    // What is running: api_suite_run, api_bug_hunt, mcp_suite_run, mcp_bug_hunt.
    kind: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["pending", "running", "success", "failed"],
      default: "pending",
      index: true,
    },

    // What it is working on, so the UI can show "running" on the right row
    // without keeping a map of job ids.
    target: {
      suiteId: { type: mongoose.Schema.Types.ObjectId, default: null },
      caseId: { type: mongoose.Schema.Types.ObjectId, default: null },
      docId: { type: mongoose.Schema.Types.ObjectId, default: null },
      projectId: { type: mongoose.Schema.Types.ObjectId, default: null },
      toolName: { type: String, default: "" },
      owner: { type: String, default: "" },
      repo: { type: String, default: "" },
      label: { type: String, default: "" },
    },

    // The payload the finished work returns, handed to the page as-is so it can
    // render the same thing it used to get from the synchronous call.
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: "" },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

// "What is this workspace running right now?" — asked on every start (to apply
// the plan's limit) and by every poll.
jobSchema.index({ companyId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Job", jobSchema);
