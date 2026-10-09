const Job = require("../model/JobModel");
const JobSlot = require("../model/JobSlotModel");
const Company = require("../model/companyModel");
const usageLimit = require("./usageLimitService");
const aiUsage = require("./aiUsageService");

// Start long work, answer immediately, let the page poll.
//
// Everything here exists so a customer can kick off three bug hunts and keep
// working, instead of watching one spinner at a time — and so the number they
// can run at once is a property of their plan rather than of how many browser
// tabs they are willing to open.
//
// How many at a time. Not about machine capacity: it is a paid difference, and
// the reason an Enterprise workspace feels faster than a free one on the same
// hardware.
const CONCURRENCY = {
  free: 1,
  test: 1,
  mcp: 2,
  api: 2,
  pro: 3,
  enterprise: 6,
};

function limitFor(plan) {
  return CONCURRENCY[plan] ?? CONCURRENCY.free;
}

/** What this workspace is running right now. */
async function running(companyId) {
  return Job.find({
    companyId,
    status: { $in: ["pending", "running"] },
  })
    .select("kind status target startedAt createdAt")
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Start a job, unless the plan's slots are full.
 *
 * `work` runs AFTER the response goes out, inside the caller's usage context so
 * its Claude spend is still billed to the right workspace. It is not awaited:
 * that is the entire point.
 */
async function start({ kind, target = {}, userId, companyId, work }) {
  const company = await Company.findById(companyId).select("plan").lean();
  const plan = company?.plan || "free";
  const limit = limitFor(plan);

  // Reserve a slot with ONE atomic update. Counting and then inserting (or
  // inserting and then counting) both let simultaneous clicks through: that is
  // how a 2-job plan ran four. A conditional $inc cannot interleave.
  await JobSlot.updateOne(
    { companyId },
    { $setOnInsert: { running: 0 } },
    { upsert: true }
  ).catch(() => {});

  const claimed = await JobSlot.findOneAndUpdate(
    { companyId, $expr: { $lt: ["$running", limit] } },
    { $inc: { running: 1 } },
    { new: true }
  );

  if (!claimed) {
    const slot = await JobSlot.findOne({ companyId }).select("running").lean();
    const err = new Error(
      limit === 1
        ? "Something is already running in this workspace. Wait for it to finish, or upgrade the plan to run several at once."
        : `This workspace is already running ${limit} jobs at once. Wait for one to finish, or upgrade the plan for more.`
    );
    err.statusCode = 429;
    err.code = "TOO_MANY_RUNNING";
    err.running = slot?.running ?? limit;
    err.limit = limit;
    throw err;
  }

  let job;
  try {
    job = await Job.create({
      kind,
      target,
      status: "running",
      startedAt: new Date(),
      userId,
      companyId,
    });
  } catch (err) {
    // The slot is taken but there is no job to release it — give it back.
    await release(companyId);
    throw err;
  }

  // Deliberately not awaited — the caller answers the browser now. The usage
  // context is carried in so a Claude call three layers down is still recorded
  // against this workspace.
  const ctx = aiUsage.currentContext();
  void aiUsage
    .runWith({ ...ctx, userId, companyId }, async () => {
      try {
        const result = await work();
        await Job.updateOne(
          { _id: job._id },
          { $set: { status: "success", result: result ?? null, finishedAt: new Date() } }
        );
      } catch (err) {
        console.error(`[job ${kind}] failed:`, err.message);
        await Job.updateOne(
          { _id: job._id },
          {
            $set: {
              status: "failed",
              error: err.message || "Unknown error",
              finishedAt: new Date(),
            },
          }
        ).catch(() => {});
      } finally {
        // Always: a slot never freed is a workspace that can never run again.
        await release(companyId);
      }
    })
    .catch(() => {});

  return job;
}

/** Hand a slot back. Never below zero, whatever happened. */
async function release(companyId) {
  await JobSlot.updateOne(
    { companyId, running: { $gt: 0 } },
    { $inc: { running: -1 } }
  ).catch((err) => console.error("[jobs] could not release a slot:", err.message));
}

/** One job, for polling. Scoped to the company so ids can't be guessed across. */
async function get(jobId, companyId) {
  return Job.findOne({ _id: jobId, companyId }).lean();
}

/**
 * Jobs stuck in "running" belong to a process that is gone (a deploy, a crash).
 * Called on boot so a dead job doesn't hold a plan's slot forever.
 */
async function failOrphans() {
  // The counters belong to processes that are gone; rebuild them from reality
  // rather than trusting a number nobody decremented.
  await JobSlot.updateMany({}, { $set: { running: 0 } }).catch(() => {});

  const res = await Job.updateMany(
    { status: { $in: ["pending", "running"] } },
    {
      $set: {
        status: "failed",
        error: "The server restarted while this was running.",
        finishedAt: new Date(),
      },
    }
  );
  if (res.modifiedCount) {
    console.log(`[jobs] released ${res.modifiedCount} job(s) left by a restart`);
  }
  return res.modifiedCount || 0;
}

module.exports = { start, get, running, failOrphans, limitFor, CONCURRENCY };
