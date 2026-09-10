const mongoose = require("mongoose");

// A standing watch on a connected repo.
//
// When something lands on the watched branch, the docs for that repo are
// regenerated, any endpoint that wasn't there before is flagged as new, and QA
// tests are generated for it. The point is that an endpoint shipped on Friday
// is already documented and covered by Monday, without anyone remembering to
// press a button.
const apiWatcherSchema = new mongoose.Schema(
  {
    installationId: { type: Number, required: true },
    owner: { type: String, required: true },
    repo: { type: String, required: true },
    // Only merges into this branch trigger a run. Anything else is noise.
    branch: { type: String, default: "main" },

    enabled: { type: Boolean, default: true },

    // Each step is optional: a team may want the docs refreshed without
    // spending model calls on tests for every new endpoint.
    actions: {
      regenerateDocs: { type: Boolean, default: true },
      generateTests: { type: Boolean, default: true },
      // Execute the generated tests against the live API right away, so the
      // morning after a merge you already know whether the new endpoint works —
      // not just that it exists. Off by default: it makes real calls, and a
      // project with no baseUrl or auth configured can't run anything.
      runTests: { type: Boolean, default: false },
    },

    lastRun: {
      at: { type: Date, default: null },
      status: { type: String, default: "" }, // running | success | failed
      newEndpoints: { type: Number, default: 0 },
      testsCreated: { type: Number, default: 0 },
      testsPassed: { type: Number, default: 0 },
      testsFailed: { type: Number, default: 0 },
    },

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

// One watcher per repo per branch.
apiWatcherSchema.index({ owner: 1, repo: 1, branch: 1 }, { unique: true });
apiWatcherSchema.index({ companyId: 1, enabled: 1 });

module.exports = mongoose.model("ApiWatcher", apiWatcherSchema);
