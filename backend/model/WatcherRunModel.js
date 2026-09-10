const mongoose = require("mongoose");

// One execution of a watcher: what triggered it, what changed, what it built.
//
// Kept as its own record rather than only a flag on the watcher because the
// value of a watch is the history — "which endpoints appeared, and when" is the
// question a QA lead actually asks after a release.
const watcherRunSchema = new mongoose.Schema(
  {
    watcherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ApiWatcher",
      required: true,
      index: true,
    },
    owner: { type: String, default: "" },
    repo: { type: String, default: "" },

    // What set it off. `manual` for a "Run now" from the UI.
    trigger: {
      kind: { type: String, default: "merge" }, // merge | manual
      prNumber: { type: Number, default: null },
      prTitle: { type: String, default: "" },
      author: { type: String, default: "" },
      sha: { type: String, default: "" },
      branch: { type: String, default: "" },
    },

    status: {
      type: String,
      enum: ["running", "success", "failed"],
      default: "running",
      index: true,
    },

    // Endpoints present after the run that weren't there before it.
    newEndpoints: {
      type: [
        new mongoose.Schema(
          {
            docId: { type: mongoose.Schema.Types.ObjectId, ref: "Doc" },
            method: String,
            path: String,
            testsCreated: { type: Number, default: 0 },
            // Filled only when the watcher was told to run what it generated.
            testsPassed: { type: Number, default: 0 },
            testsFailed: { type: Number, default: 0 },
            runError: { type: String, default: "" },
            testError: { type: String, default: "" },
            // Bug hunter results for this endpoint — separate from the suites.
            bugsFound: { type: Number, default: 0 },
            qaRunId: { type: String, default: "" },
            qaError: { type: String, default: "" },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    docsBefore: { type: Number, default: 0 },
    docsAfter: { type: Number, default: 0 },
    error: { type: String, default: "" },

    startedAt: { type: Date, default: Date.now },
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

watcherRunSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("WatcherRun", watcherRunSchema);
