const mongoose = require("mongoose");

// One execution of an MCP watcher: which merge set it off, how long it had to
// wait for the deploy, which tools appeared, and what QA found on them.
const mcpWatcherRunSchema = new mongoose.Schema(
  {
    watcherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "McpWatcher",
      required: true,
      index: true,
    },
    mcpProjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "McpProject",
      index: true,
    },
    projectName: { type: String, default: "" },
    owner: { type: String, default: "" },
    repo: { type: String, default: "" },

    trigger: {
      kind: { type: String, default: "merge" },
      prNumber: { type: Number, default: null },
      prTitle: { type: String, default: "" },
      author: { type: String, default: "" },
      sha: { type: String, default: "" },
      branch: { type: String, default: "" },
    },

    // pending = recorded, not yet picked up. Written by the webhook BEFORE any
    // work starts so a restart mid-wait doesn't lose the trigger.
    status: {
      type: String,
      enum: ["pending", "running", "success", "failed"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },

    // The tool set as it was when the merge arrived. Captured at enqueue, not
    // at run time, so a run resumed after a restart still compares against the
    // server as it was BEFORE the deploy — not against a list it already
    // partially refreshed.
    toolsBeforeNames: { type: [String], default: [] },
    toolsAfter: { type: Number, default: 0 },

    // How many times the live server was asked for its tools before the new
    // ones showed up (or the watcher gave up). Tells you how long the deploy
    // actually took.
    checks: { type: Number, default: 0 },
    note: { type: String, default: "" },

    newTools: {
      type: [
        new mongoose.Schema(
          {
            name: String,
            testsCreated: { type: Number, default: 0 },
            testsPassed: { type: Number, default: 0 },
            testsFailed: { type: Number, default: 0 },
            testError: { type: String, default: "" },
            bugsFound: { type: Number, default: 0 },
            qaRunId: { type: String, default: "" },
            qaError: { type: String, default: "" },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

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

mcpWatcherRunSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("McpWatcherRun", mcpWatcherRunSchema);
