const jobs = require("../services/jobService");

function requireCompany(req, res) {
  if (!req.user?.companyId) {
    res.status(400).json({ message: "User has no company" });
    return false;
  }
  return true;
}

/** One job — what the page polls after starting a run. */
async function getJob(req, res) {
  if (!requireCompany(req, res)) return;
  const job = await jobs.get(req.params.id, req.user.companyId);
  if (!job) return res.status(404).json({ message: "Job not found" });
  res.json({
    _id: job._id,
    kind: job.kind,
    status: job.status,
    target: job.target,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  });
}

/**
 * Everything this workspace is running, plus how many it may run at once.
 *
 * Lets a page show "running" on the right rows after a reload, and lets the UI
 * say "2 of 3" instead of discovering the limit by being refused.
 */
async function listRunningJobs(req, res) {
  if (!requireCompany(req, res)) return;
  const Company = require("../model/companyModel");
  const company = await Company.findById(req.user.companyId).select("plan").lean();
  const active = await jobs.running(req.user.companyId);
  res.json({
    running: active,
    limit: jobs.limitFor(company?.plan || "free"),
  });
}

module.exports = { getJob, listRunningJobs };
