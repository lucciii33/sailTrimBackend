const mongoose = require("mongoose");

// A standing watch that ties an MCP project to the GitHub repo its server is
// built from.
//
// MCP projects have no repo of their own — they point at a live server. So the
// watcher IS the link: a merge into `branch` of `owner/repo` means the server
// behind `mcpProjectId` is about to change.
//
// Unlike the API watcher, the source of truth here is the LIVE server, not the
// code. At the moment of the merge that server is still running the old build,
// so the watcher re-checks it on an interval until the new tools appear (or
// gives up after `wait.maxMinutes`).
const mcpWatcherSchema = new mongoose.Schema(
  {
    mcpProjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "McpProject",
      required: true,
      index: true,
    },
    installationId: { type: Number, required: true },
    owner: { type: String, required: true },
    repo: { type: String, required: true },
    branch: { type: String, default: "main" },

    enabled: { type: Boolean, default: true },

    actions: {
      // Saved smoke + regression suites per new tool.
      generateTests: { type: Boolean, default: true },
      // Execute those suites right away. Off by default: it invokes the tools
      // for real, and a tool that writes will write.
      runTests: { type: Boolean, default: false },
      // The MCP bug hunter on each new tool — the report worth reading after a
      // merge. Same caveat: it calls the tools.
      runQa: { type: Boolean, default: true },
    },

    // How long to keep looking for the new tools after a merge. The deploy lags
    // the merge by an unknown amount; checking once would usually see the old
    // server and report nothing.
    wait: {
      intervalSec: { type: Number, default: 60 },
      maxMinutes: { type: Number, default: 15 },
    },

    lastRun: {
      at: { type: Date, default: null },
      status: { type: String, default: "" },
      newTools: { type: Number, default: 0 },
      testsCreated: { type: Number, default: 0 },
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

mcpWatcherSchema.index(
  { mcpProjectId: 1, owner: 1, repo: 1, branch: 1 },
  { unique: true }
);
mcpWatcherSchema.index({ owner: 1, repo: 1, branch: 1, enabled: 1 });

module.exports = mongoose.model("McpWatcher", mcpWatcherSchema);
