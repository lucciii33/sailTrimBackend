const Installation = require("../model/Installation");
const BackfillJob = require("../model/BackfillJob");
const {
  getOctokit,
  scanRepoForApiFiles,
  fetchBlobContent,
  fileLooksLikeApi,
} = require("../services/githubService");
const {
  generateDocsFromFile,
  saveBackfillDocs,
} = require("../services/docService");

const CONCURRENCY = 5;

async function githubCallback(req, res) {
  const { installation_id, state } = req.query;

  if (!installation_id || !state) {
    return res.status(400).json({ message: "Missing installation_id or state" });
  }

  await Installation.findOneAndUpdate(
    { installationId: Number(installation_id) },
    { userId: state },
    { new: true, upsert: true }
  );

  res.status(200).json({ message: "Installation linked to user" });
}

async function runBackfill(jobId) {
  const job = await BackfillJob.findById(jobId);
  if (!job) return;

  try {
    job.status = "running";
    job.startedAt = new Date();
    await job.save();

    const octokit = await getOctokit(job.installationId);
    const candidates = await scanRepoForApiFiles(octokit, job.owner, job.repo);

    const hydrated = [];
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (c) => {
          try {
            const content = await fetchBlobContent(
              octokit,
              job.owner,
              job.repo,
              c.sha,
            );
            return fileLooksLikeApi(content) ? { ...c, content } : null;
          } catch (err) {
            console.error(`Failed to fetch blob ${c.path}:`, err.message);
            return null;
          }
        }),
      );
      results.filter(Boolean).forEach((r) => hydrated.push(r));
    }

    job.filesFound = hydrated.length;
    await job.save();

    let totalEndpoints = 0;
    for (let i = 0; i < hydrated.length; i += CONCURRENCY) {
      const batch = hydrated.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            const endpoints = await generateDocsFromFile({
              filePath: file.path,
              content: file.content,
            });
            const saved = await saveBackfillDocs({
              endpoints,
              repo: job.repo,
              owner: job.owner,
              userId: job.userId,
              sourceFile: file.path,
              sourceSha: file.sha,
            });
            return saved;
          } catch (err) {
            console.error(`Failed to doc ${file.path}:`, err.message);
            return 0;
          }
        }),
      );
      totalEndpoints += results.reduce((a, b) => a + b, 0);
      job.filesProcessed += batch.length;
      job.endpointsDetected = totalEndpoints;
      await job.save();
    }

    job.status = "completed";
    job.finishedAt = new Date();
    await job.save();
  } catch (err) {
    console.error("Backfill failed:", err);
    job.status = "failed";
    job.error = err.message;
    job.finishedAt = new Date();
    await job.save();
  }
}

async function startBackfill(req, res) {
  const { installationId, owner, repo } = req.body;

  if (!installationId || !owner || !repo) {
    return res
      .status(400)
      .json({ message: "installationId, owner and repo are required" });
  }

  const installation = await Installation.findOne({
    installationId: Number(installationId),
  });
  if (!installation) {
    return res.status(404).json({ message: "Installation not found" });
  }

  const job = await BackfillJob.create({
    installationId: Number(installationId),
    owner,
    repo,
    userId: installation.userId,
  });

  runBackfill(job._id).catch((err) =>
    console.error("runBackfill crashed:", err),
  );

  res.status(202).json({ jobId: job._id, status: job.status });
}

async function getBackfillJob(req, res) {
  const job = await BackfillJob.findById(req.params.jobId);
  if (!job) return res.status(404).json({ message: "Job not found" });
  res.status(200).json(job);
}

module.exports = { githubCallback, startBackfill, getBackfillJob };
