const McpWatcher = require("../model/McpWatcherModel");
const McpWatcherRun = require("../model/McpWatcherRunModel");
const McpProject = require("../model/McpProjectModel");
const McpTool = require("../model/McpToolModel");
const Installation = require("../model/Installation");
// Same plan gate and branch check as the API watchers — imported, not copied.
const { requirePro, branchProblem } = require("./watcherController");

function requireCompany(req, res) {
  if (!req.user.companyId) {
    res.status(400).json({ message: "User has no company" });
    return false;
  }
  return true;
}

async function listMcpWatchers(req, res) {
  if (!requireCompany(req, res)) return;
  const watchers = await McpWatcher.find({ companyId: req.user.companyId })
    .sort({ updatedAt: -1 })
    .lean();
  // Attach the project name so the UI doesn't need a second lookup per row.
  const projects = await McpProject.find({
    _id: { $in: watchers.map((w) => w.mcpProjectId) },
  })
    .select("projectName")
    .lean();
  const nameById = new Map(projects.map((p) => [String(p._id), p.projectName]));
  res.json(
    watchers.map((w) => ({ ...w, projectName: nameById.get(String(w.mcpProjectId)) || "" }))
  );
}

// Link an MCP project to the repo its server is built from, and start watching.
async function createMcpWatcher(req, res) {
  if (!requireCompany(req, res)) return;
  if (!(await requirePro(req, res))) return;

  const { mcpProjectId, owner, repo, branch = "main", actions, wait } = req.body || {};
  if (!mcpProjectId || !owner || !repo) {
    return res
      .status(400)
      .json({ message: "mcpProjectId, owner and repo are required" });
  }

  const project = await McpProject.findOne({
    _id: mcpProjectId,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "MCP project not found" });

  const installation = await Installation.findOne({
    accountLogin: owner,
    $or: [{ companyId: req.user.companyId }, { userId: req.user._id }],
  });
  if (!installation) {
    return res.status(404).json({
      message: `No connected GitHub installation for "${owner}". Connect the repo first.`,
    });
  }

  const problem = await branchProblem(installation.installationId, owner, repo, branch);
  if (problem) {
    return res.status(400).json({ message: problem, code: "BRANCH_NOT_FOUND" });
  }

  try {
    const watcher = await McpWatcher.findOneAndUpdate(
      { mcpProjectId, owner, repo, branch },
      {
        $set: {
          mcpProjectId,
          installationId: installation.installationId,
          owner,
          repo,
          branch,
          enabled: true,
          ...(actions ? { actions } : {}),
          ...(wait ? { wait } : {}),
          userId: req.user._id,
          companyId: req.user.companyId,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.status(201).json(watcher);
  } catch (err) {
    if (err.code === 11000) {
      return res
        .status(409)
        .json({ message: "This MCP project is already watching that branch." });
    }
    throw err;
  }
}

async function updateMcpWatcher(req, res) {
  if (!requireCompany(req, res)) return;
  const { enabled, actions, branch, wait } = req.body || {};
  const watcher = await McpWatcher.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!watcher) return res.status(404).json({ message: "Watcher not found" });

  if (typeof enabled === "boolean") watcher.enabled = enabled;
  if (actions) watcher.actions = { ...(watcher.actions?.toObject?.() ?? watcher.actions), ...actions };
  if (wait) watcher.wait = { ...(watcher.wait?.toObject?.() ?? watcher.wait), ...wait };
  if (branch && branch !== watcher.branch) {
    const problem = await branchProblem(
      watcher.installationId,
      watcher.owner,
      watcher.repo,
      branch
    );
    if (problem) {
      return res.status(400).json({ message: problem, code: "BRANCH_NOT_FOUND" });
    }
    watcher.branch = branch;
  }
  await watcher.save();
  res.json(watcher);
}

async function deleteMcpWatcher(req, res) {
  if (!requireCompany(req, res)) return;
  const del = await McpWatcher.deleteOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!del.deletedCount) return res.status(404).json({ message: "Watcher not found" });
  res.json({ success: true });
}

async function listMcpRuns(req, res) {
  if (!requireCompany(req, res)) return;
  const filter = { companyId: req.user.companyId };
  if (req.params.id) filter.watcherId = req.params.id;
  const runs = await McpWatcherRun.find(filter)
    .sort({ createdAt: -1 })
    .limit(Number(req.query.limit) || 20)
    .lean();
  res.json(runs);
}

async function listNewTools(req, res) {
  if (!requireCompany(req, res)) return;
  const tools = await McpTool.find({
    companyId: req.user.companyId,
    isNewTool: true,
  })
    .select("name projectId firstSeenAt firstSeenPr")
    .sort({ firstSeenAt: -1 })
    .lean();
  const projects = await McpProject.find({
    _id: { $in: tools.map((t) => t.projectId) },
  })
    .select("projectName")
    .lean();
  const nameById = new Map(projects.map((p) => [String(p._id), p.projectName]));
  res.json(
    tools.map((t) => ({ ...t, projectName: nameById.get(String(t.projectId)) || "" }))
  );
}

async function acknowledgeNewTools(req, res) {
  if (!requireCompany(req, res)) return;
  const { toolIds } = req.body || {};
  const filter = { companyId: req.user.companyId, isNewTool: true };
  if (Array.isArray(toolIds) && toolIds.length) filter._id = { $in: toolIds };
  const r = await McpTool.updateMany(filter, { $set: { isNewTool: false } });
  res.json({ cleared: r.modifiedCount });
}

module.exports = {
  listMcpWatchers,
  createMcpWatcher,
  updateMcpWatcher,
  deleteMcpWatcher,
  listMcpRuns,
  listNewTools,
  acknowledgeNewTools,
};
