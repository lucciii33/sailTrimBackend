const jwt = require("jsonwebtoken");
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
  extractMountedModulePaths,
  extractMountPrefixes,
  isOrphanRouteFile,
  MAX_FILE_BYTES,
} = require("../services/githubService");
const {
  generateDocsFromFile,
  saveBackfillDocs,
  cleanupZombieDocs,
  CLAUDE_MODEL,
} = require("../services/docService");
const { getUserAnthropicClient } = require("../services/userKeyService");
const { renderGithubResultPage } = require("../views/githubResultPage");
const PendingInstall = require("../model/PendingInstall");

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

// `state` used to be the raw user id, sitting in plain view in the
// "Connect GitHub" URL — anyone could hand-craft that URL with someone
// else's id and our callback would trust it blindly. Instead we sign it as
// a short-lived, purpose-scoped token: only our server can mint one (via
// getConnectLink, behind `protect`), and the callback verifies it instead
// of trusting it. 15 minutes is plenty for "click connect -> pick org on
// GitHub -> come back"; reuse within that window is allowed (stateless
// JWT, no single-use tracking) since the blast radius of a leaked link is
// already capped by the short expiry.
const CONNECT_STATE_PURPOSE = "github_connect";
const CONNECT_STATE_TTL = "15m";

function signConnectState(userId) {
  return jwt.sign(
    { sub: String(userId), purpose: CONNECT_STATE_PURPOSE },
    process.env.JWT_SECRET_NODE,
    { expiresIn: CONNECT_STATE_TTL }
  );
}

// Returns the user id encoded in `state` only if it's a real, unexpired
// token we issued for this exact purpose — null for anything else
// (missing, malformed, expired, or a token issued for something else).
// Callers treat null the same as "no state" rather than throwing, so a
// bad/expired state degrades to an unlinked installation instead of a hard
// failure.
function resolveStateUserId(state) {
  if (!state) return null;
  try {
    const decoded = jwt.verify(state, process.env.JWT_SECRET_NODE);
    if (decoded.purpose !== CONNECT_STATE_PURPOSE) return null;
    return decoded.sub;
  } catch (_) {
    return null;
  }
}

// Authenticated endpoint the frontend calls right before sending the user
// to GitHub, instead of building the install URL itself with a raw id.
async function getConnectLink(req, res) {
  const state = signConnectState(req.user._id);
  const slug = process.env.GITHUB_APP_SLUG || "OliviaTools";
  res.json({
    url: `https://github.com/apps/${slug}/installations/new?state=${state}`,
  });
}

async function githubCallback(req, res) {
  const { installation_id, state: rawState, setup_action } = req.query;
  const frontendUrl = process.env.FRONTEND_URL;
  const state = resolveStateUserId(rawState);

  // rawState present but state resolved to null = a real token was sent but
  // it's invalid/expired/tampered — show a clear error instead of silently
  // proceeding unlinked. (No rawState at all is a different, allowed case —
  // handled further down, same as before.)
  if (rawState && !state) {
    return res
      .status(400)
      .type("html")
      .send(
        renderGithubResultPage({
          variant: "error",
          title: "This link expired",
          message:
            "This connection link is invalid or expired (links last 15 minutes). Go back to OliviaTools and click \"Connect GitHub\" again to get a fresh one.",
          ctaHref: frontendUrl || undefined,
          ctaLabel: frontendUrl ? "Back to OliviaTools" : undefined,
        })
      );
  }

  // GitHub sends the user here with setup_action=request (and NO
  // installation_id) when they tried to install on an org where they're not
  // an admin: instead of installing, GitHub sends an approval request to the
  // org owner and the install stays pending. This is a normal, expected flow
  // for org installs — show a friendly "pending approval" page, not an error.
  if (!installation_id && setup_action === "request") {
    // Remember who asked, so the later approval webhook (which carries no
    // `state`) can link the installation back to this user. See PendingInstall.
    if (state) {
      try {
        const user = await User.findById(state).select("companyId");
        await PendingInstall.create({
          userId: state,
          companyId: user?.companyId || undefined,
        });
      } catch (err) {
        console.error("Failed to record pending install:", err.message);
      }
    }
    return res
      .status(200)
      .type("html")
      .send(
        renderGithubResultPage({
          variant: "pending",
          title: "Request sent",
          message:
            "You requested to install OliviaTools on an organization where you're not an admin. GitHub has sent an approval request to the organization owner. Once they approve it, your connection will activate automatically.",
          ctaHref: frontendUrl || undefined,
          ctaLabel: frontendUrl ? "Back to OliviaTools" : undefined,
        })
      );
  }

  if (!installation_id) {
    return res
      .status(400)
      .type("html")
      .send(
        renderGithubResultPage({
          variant: "error",
          title: "We couldn't complete the installation",
          message:
            "GitHub didn't send an installation identifier. Please try installing the app again from OliviaTools. If the problem persists, contact us.",
          ctaHref: frontendUrl || undefined,
          ctaLabel: frontendUrl ? "Back to OliviaTools" : undefined,
        })
      );
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

    // Resolve which route files are actually required by a mount call, so
    // route files that exist in the repo but nothing ever wires up (dead
    // code) get flagged instead of documented as if they were live.
    const mountedPaths = await extractMountedModulePaths(mountContext);
    // Exact prefix per module, resolved from the entry file's AST (today:
    // JS/TS and Python) — a fact we can hand the LLM instead of asking it
    // to infer the prefix from raw mount-context text.
    const mountPrefixes = await extractMountPrefixes(mountContext);
    console.log(
      `[backfill ${job._id}] mountedPaths=${mountedPaths.size} mountPrefixes=${mountPrefixes.size}`
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
    const failedFiles = [];

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
            const normalizedPath = file.path.replace(/\.(jsx?|tsx?|py)$/i, "");
            const knownPrefix = mountPrefixes.has(normalizedPath)
              ? mountPrefixes.get(normalizedPath)
              : undefined;
            if (knownPrefix !== undefined) {
              console.log(
                `[backfill ${job._id}] ${file.path}: verified prefix "${knownPrefix}" (from AST, not a guess)`
              );
            }
            const { endpoints, usage } = await generateDocsFromFile({
              filePath: file.path,
              content: file.content,
              mountContext,
              schemaContext: relevantSchemas,
              knownPrefix,
              anthropicClient,
            });
            const orphan = isOrphanRouteFile(file.path, mountedPaths);
            if (orphan) {
              console.log(
                `[backfill ${job._id}] ${file.path}: looks like a route file but isn't mounted anywhere — flagging as unmounted`
              );
            }
            console.log(
              `[backfill ${job._id}] ${file.path}: Claude returned ${endpoints.length} endpoint(s)`
            );
            const saved = await saveBackfillDocs({
              endpoints,
              repo: job.repo,
              owner: job.owner,
              userId: job.userId,
              companyId,
              sourceFile: file.path,
              sourceSha: file.sha,
              mounted: !orphan,
            });
            console.log(`[backfill ${job._id}] ${file.path}: saved ${saved} doc(s)`);
            return { saved, usage, sha: file.sha, cached: false, failed: false };
          } catch (err) {
            // Surface the full failure — this used to log only err.message
            // and report saved:0 identically to "this file genuinely has no
            // endpoints", which made a real failure (e.g. a truncated
            // Claude response) indistinguishable from a legitimately empty
            // file. failed:true below makes that distinction explicit.
            console.error(`[backfill ${job._id}] FAILED to doc ${file.path}:`, err.stack || err.message);
            return {
              saved: 0,
              usage: { inputTokens: 0, outputTokens: 0 },
              sha: file.sha,
              cached: false,
              failed: true,
              failedPath: file.path,
              error: err.message,
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
        if (r.failed) failedFiles.push({ path: r.failedPath, error: r.error || "unknown error" });
      }

      job.filesProcessed += batch.length;
      job.filesCached = cachedCount;
      job.filesFailed = failedFiles.length;
      job.failedFiles = failedFiles;
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

module.exports = { githubCallback, getConnectLink, startBackfill, getBackfillJob };
