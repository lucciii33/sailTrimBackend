const Installation = require("../model/Installation");
const BackfillJob = require("../model/BackfillJob");
const Doc = require("../model/DocModel");
const User = require("../model/userModel");
const {
  getApp,
  getOctokit,
  scanRepoTree,
  fetchBlobContent,
  fetchMountContext,
  fetchSchemaContext,
  pickSchemasForFile,
  fileLooksLikeApi,
  MAX_FILE_BYTES,
} = require("../services/githubService");
const {
  generateDocsFromFile,
  saveBackfillDocs,
  cleanupZombieDocs,
  CLAUDE_MODEL,
} = require("../services/docService");
const { getUserAnthropicClient } = require("../services/userKeyService");

const CONCURRENCY = 2;

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
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "target",
  "bin",
  "obj",
  "out",
];
const SOURCE_EXTENSIONS = [
  ".js", ".ts", ".mjs", ".cjs", ".tsx", ".jsx",
  ".py",
  ".rb",
  ".go",
  ".java", ".kt",
  ".php",
  ".cs",
  ".rs",
  ".ex", ".exs",
  ".scala",
  ".swift",
];

function isExcludedPath(p) {
  const parts = p.split("/");
  return (
    parts.some((part) => EXCLUDED_DIRS.includes(part)) ||
    p.endsWith(".min.js") ||
    /\.(test|spec)\.[jt]sx?$/.test(p) ||
    /_test\.(go|py|rb)$/.test(p) ||
    /_spec\.rb$/.test(p)
  );
}
function hasSourceExtension(p) {
  return SOURCE_EXTENSIONS.some((ext) => p.endsWith(ext));
}

async function fetchInstallationRepos(octokit) {
  const repos = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.request("GET /installation/repositories", {
      per_page: 100,
      page,
    });
    repos.push(...data.repositories);
    if (data.repositories.length < 100) break;
    page += 1;
  }
  return repos;
}

async function githubCallback(req, res) {
  const { installation_id, state } = req.query;

  if (!installation_id) {
    return res.status(400).json({ message: "Missing installation_id" });
  }

  const installationId = Number(installation_id);

  try {
    const octokit = await getOctokit(installationId);
    const ghRepos = await fetchInstallationRepos(octokit);

    const repos = ghRepos.map((r) => ({
      repoName: r.name,
      repoFullName: r.full_name,
    }));

    let accountLogin;
    let accountType;
    if (ghRepos.length > 0) {
      accountLogin = ghRepos[0].owner.login;
      accountType = ghRepos[0].owner.type;
    } else {
      const app = await getApp();
      const { data } = await app.octokit.request(
        "GET /app/installations/{installation_id}",
        { installation_id: installationId }
      );
      accountLogin = data.account.login;
      accountType = data.account.type;
    }

    const update = {
      installationId,
      accountLogin,
      accountType,
      repos,
    };
    if (state) {
      update.userId = state;
      const user = await User.findById(state).select("companyId");
      if (user?.companyId) update.companyId = user.companyId;
    }

    await Installation.findOneAndUpdate(
      { installationId },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const frontendUrl = process.env.FRONTEND_URL;
    if (frontendUrl) {
      return res.redirect(`${frontendUrl}/docs?installed=1`);
    }
    return res.status(200).json({
      message: "Installation linked to user",
      installationId,
      repos,
    });
  } catch (err) {
    console.error("githubCallback failed:", err);
    return res
      .status(500)
      .json({ message: "Failed to sync installation", error: err.message });
  }
}

async function runBackfill(jobId) {
  const job = await BackfillJob.findById(jobId);
  if (!job) return;

  try {
    job.status = "running";
    job.startedAt = new Date();
    job.model = CLAUDE_MODEL;
    await job.save();

    const anthropicClient = await getUserAnthropicClient(job.userId);
    const octokit = await getOctokit(job.installationId);

    // Resolve companyId for the docs we'll save. Prefer the denormalized
    // value on Installation; fall back to the User lookup for old installs.
    const installation = await Installation.findOne({
      installationId: job.installationId,
    });
    let companyId = installation?.companyId || null;
    if (!companyId && job.userId) {
      const owner = await User.findById(job.userId).select("companyId");
      companyId = owner?.companyId || null;
    }

    // 1) Full tree once — used both for mount context and candidate selection.
    const tree = await scanRepoTree(octokit, job.owner, job.repo);
    console.log(`[backfill ${job._id}] tree size:`, tree.length);
    console.log(
      `[backfill ${job._id}] first 20 paths:`,
      tree.slice(0, 20).map((n) => `${n.type}:${n.path}`)
    );

    // 2) Mount context (server.js, app.js, …) and schema context
    //    (models/, schemas/, dto/, …) fetched once and reused on every
    //    per-route Claude call so nested types get fully expanded.
    const [mountContext, schemaContext] = await Promise.all([
      fetchMountContext(octokit, job.owner, job.repo, tree),
      fetchSchemaContext(octokit, job.owner, job.repo, tree),
    ]);
    console.log(
      `[backfill ${job._id}] mount=${mountContext.length} schemas=${schemaContext.length}`
    );

    // 3) Pick candidates: every source file in the repo. The regex check
    //    on content (fileLooksLikeApi) does the real filtering — path
    //    structure varies too much across repos to gate on it.
    const blobs = tree.filter((n) => n.type === "blob");
    const sourceFiles = blobs.filter((n) => hasSourceExtension(n.path));
    const candidates = sourceFiles
      .filter((n) => !isExcludedPath(n.path))
      .map((n) => ({ path: n.path, sha: n.sha, size: n.size }));
    console.log(
      `[backfill ${job._id}] blobs=${blobs.length} sourceFiles=${sourceFiles.length} candidates=${candidates.length}`
    );
    console.log(
      `[backfill ${job._id}] candidate paths:`,
      candidates.map((c) => c.path)
    );

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

            const relevantSchemas = pickSchemasForFile(file.content, schemaContext);
            console.log(
              `[backfill ${job._id}] ${file.path}: schemas=${relevantSchemas.length}/${schemaContext.length}`
            );
            const { endpoints, usage } = await generateDocsFromFile({
              filePath: file.path,
              content: file.content,
              mountContext,
              schemaContext: relevantSchemas,
              anthropicClient,
            });
            const saved = await saveBackfillDocs({
              endpoints,
              repo: job.repo,
              owner: job.owner,
              userId: job.userId,
              companyId,
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
  console.log("==================================================");
  console.log("[startBackfill] HIT");
  console.log("[startBackfill] body:", req.body);
  console.log("==================================================");

  const { installationId, owner, repo, force } = req.body;

  if (!installationId || !owner || !repo) {
    console.log("[startBackfill] MISSING FIELDS — bailing");
    return res
      .status(400)
      .json({ message: "installationId, owner and repo are required" });
  }

  const installation = await Installation.findOne({
    installationId: Number(installationId),
  });
  console.log(
    "[startBackfill] installation lookup:",
    installation ? `found userId=${installation.userId} repos=${installation.repos?.length}` : "NOT FOUND"
  );

  if (!installation) {
    return res.status(404).json({ message: "Installation not found" });
  }

  // force=true wipes existing backfill docs for this repo so the SHA cache
  // (line ~250 below) doesn't short-circuit Claude and we get a clean
  // regeneration with the latest prompt / schema context.
  if (force) {
    const wiped = await Doc.deleteMany({ owner, repo, source: "backfill" });
    console.log(
      `[startBackfill] force=true — wiped ${wiped.deletedCount} existing backfill docs`
    );
  }

  const job = await BackfillJob.create({
    installationId: Number(installationId),
    owner,
    repo,
    userId: installation.userId,
  });
  console.log("[startBackfill] job created:", job._id.toString());

  runBackfill(job._id).catch((err) =>
    console.error("[runBackfill] CRASHED:", err)
  );

  res.status(202).json({ jobId: job._id, status: job.status });
}

async function getBackfillJob(req, res) {
  const job = await BackfillJob.findById(req.params.jobId);
  if (!job) return res.status(404).json({ message: "Job not found" });
  res.status(200).json(job);
}

module.exports = { githubCallback, startBackfill, getBackfillJob };
