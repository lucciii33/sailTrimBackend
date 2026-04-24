const Installation = require("../model/Installation");
const BackfillJob = require("../model/BackfillJob");
const Doc = require("../model/DocModel");
const {
  getOctokit,
  scanRepoTree,
  fetchBlobContent,
  fetchMountContext,
  fileLooksLikeApi,
  MAX_FILE_BYTES,
} = require("../services/githubService");
const {
  generateDocsFromFile,
  saveBackfillDocs,
  cleanupZombieDocs,
  CLAUDE_MODEL,
} = require("../services/docService");

const CONCURRENCY = 5;

// Same filters that used to live behind scanRepoForApiFiles. Kept inline now
// because we also need the full tree for mount-context detection.
const API_PATH_HINTS = [
  "route",
  "routes",
  "controller",
  "controllers",
  "api",
  "handler",
  "handlers",
  "endpoint",
  "endpoints",
];
const EXCLUDED_DIRS = [
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  "__tests__",
  "test",
  "tests",
  "spec",
  ".git",
];
const SOURCE_EXTENSIONS = [".js", ".ts", ".mjs", ".cjs", ".tsx"];

function isExcludedPath(p) {
  const parts = p.split("/");
  return (
    parts.some((part) => EXCLUDED_DIRS.includes(part)) ||
    p.endsWith(".min.js") ||
    /\.(test|spec)\.[jt]sx?$/.test(p)
  );
}
function hasApiPathHint(p) {
  const lower = p.toLowerCase();
  return API_PATH_HINTS.some((hint) => lower.includes(hint));
}
function hasSourceExtension(p) {
  return SOURCE_EXTENSIONS.some((ext) => p.endsWith(ext));
}

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
    job.model = CLAUDE_MODEL;
    await job.save();

    const octokit = await getOctokit(job.installationId);

    // 1) Full tree once — used both for mount context and candidate selection.
    const tree = await scanRepoTree(octokit, job.owner, job.repo);

    // 2) Mount context (server.js, app.js, …) fetched once and reused.
    const mountContext = await fetchMountContext(octokit, job.owner, job.repo, tree);

    // 3) Pick candidates: route/controller/api files only.
    const candidates = tree
      .filter((n) => n.type === "blob")
      .filter((n) => hasSourceExtension(n.path))
      .filter((n) => !isExcludedPath(n.path))
      .filter((n) => hasApiPathHint(n.path))
      .map((n) => ({ path: n.path, sha: n.sha, size: n.size }));

    // 4) Hydrate + pre-filter by route-regex. Skip oversized files.
    const hydrated = [];
    let skipped = 0;
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (c) => {
          if (c.size && c.size > MAX_FILE_BYTES) {
            skipped += 1;
            return null;
          }
          try {
            const content = await fetchBlobContent(
              octokit,
              job.owner,
              job.repo,
              c.sha
            );
            if (content.length > MAX_FILE_BYTES) {
              skipped += 1;
              return null;
            }
            return fileLooksLikeApi(content) ? { ...c, content } : null;
          } catch (err) {
            console.error(`Failed to fetch blob ${c.path}:`, err.message);
            return null;
          }
        })
      );
      results.filter(Boolean).forEach((r) => hydrated.push(r));
    }

    job.filesFound = hydrated.length;
    job.filesSkipped = skipped;
    await job.save();

    // 5) Generate docs. Mount context is passed to every call so Claude can
    //    resolve prefixes like /api/user/login.
    //    sha cache: if the file's sha already has docs, we skip the Claude
    //    call and reuse the existing docs — that sha is unchanged since
    //    the last backfill, so re-processing is wasted money.
    let totalEndpoints = 0;
    let totalIn = 0;
    let totalOut = 0;
    let cachedCount = 0;
    const processedShas = [];

    for (let i = 0; i < hydrated.length; i += CONCURRENCY) {
      const batch = hydrated.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            // sha cache check: cheap Mongo count vs expensive Claude call
            const existing = await Doc.countDocuments({
              owner: job.owner,
              repo: job.repo,
              source: "backfill",
              sourceSha: file.sha,
            });
            if (existing > 0) {
              return {
                saved: existing,
                usage: { inputTokens: 0, outputTokens: 0 },
                sha: file.sha,
                cached: true,
              };
            }

            const { endpoints, usage } = await generateDocsFromFile({
              filePath: file.path,
              content: file.content,
              mountContext,
            });
            const saved = await saveBackfillDocs({
              endpoints,
              repo: job.repo,
              owner: job.owner,
              userId: job.userId,
              sourceFile: file.path,
              sourceSha: file.sha,
            });
            return { saved, usage, sha: file.sha, cached: false };
          } catch (err) {
            console.error(`Failed to doc ${file.path}:`, err.message);
            return {
              saved: 0,
              usage: { inputTokens: 0, outputTokens: 0 },
              sha: file.sha,
              cached: false,
            };
          }
        })
      );

      for (const r of results) {
        totalEndpoints += r.saved;
        totalIn += r.usage.inputTokens || 0;
        totalOut += r.usage.outputTokens || 0;
        processedShas.push(r.sha);
        if (r.cached) cachedCount += 1;
      }

      job.filesProcessed += batch.length;
      job.filesCached = cachedCount;
      job.endpointsDetected = totalEndpoints;
      job.tokensInput = totalIn;
      job.tokensOutput = totalOut;
      await job.save();
    }

    // 6) Zombie cleanup: drop backfill docs whose source file was removed.
    const removed = await cleanupZombieDocs({
      owner: job.owner,
      repo: job.repo,
      liveShas: processedShas,
    });
    job.zombieDocsRemoved = removed;

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
    console.error("runBackfill crashed:", err)
  );

  res.status(202).json({ jobId: job._id, status: job.status });
}

async function getBackfillJob(req, res) {
  const job = await BackfillJob.findById(req.params.jobId);
  if (!job) return res.status(404).json({ message: "Job not found" });
  res.status(200).json(job);
}

module.exports = { githubCallback, startBackfill, getBackfillJob };
