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
    // Chosen by the user so the watch is recognisable in lists and banners
    // ("Orders API — prod"). Older watchers have none; the UI falls back to the repo.
    name: { type: String, default: "", trim: true, maxlength: 80 },
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
      // The bug hunter — a DIFFERENT thing from the suites above. Those are
      // saved regression/smoke checks; this generates throwaway cases and
      // reports actual bugs in the endpoint that just shipped. That report is
      // the thing worth reading the morning after a merge.
      runQa: { type: Boolean, default: true },
      // The QA review of the merged PR: tests of every type against what it
      // changed, a verdict with evidence, and questions, commented on the PR.
      // Off by default: it makes real requests, including attacks, so it must
      // only point at a dev or staging environment.
      prReview: { type: Boolean, default: false },
    },

    // Minutes to wait after a merge before reviewing, so the branch's deploy
    // has finished and the tests hit the new code.
    deployWaitMinutes: { type: Number, default: 0, min: 0, max: 30 },

    // Where the PR review sends its requests: the environment this branch
    // deploys to. Required for the review, and never taken from the repo's QA
    // settings, whose base URL may well be production.
    reviewBaseUrl: { type: String, default: "", trim: true },

    lastRun: {
      at: { type: Date, default: null },
      status: { type: String, default: "" }, // running | success | failed
      newEndpoints: { type: Number, default: 0 },
      testsCreated: { type: Number, default: 0 },
      testsPassed: { type: Number, default: 0 },
      testsFailed: { type: Number, default: 0 },
      bugsFound: { type: Number, default: 0 },
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
