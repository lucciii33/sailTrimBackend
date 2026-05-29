const crypto = require("crypto");
const Installation = require("../model/Installation");
const {
  getOctokit,
  getPRDiff,
  commentOnPR,
  getPRFiles,
  fetchFileAtRef,
  fetchMountContextAtRef,
  fileLooksLikeApi,
  MAX_FILE_BYTES,
  SOURCE_EXTENSIONS,
} = require("../services/githubService");
const { generateTestCases, summarizePR } = require("../services/aiService");
const { postMessage: postSlackMessage } = require("../services/slackService");
const { generateDocsFromFile } = require("../services/docService");
const Doc = require("../model/DocModel");
const User = require("../model/userModel");
const Company = require("../model/companyModel");
const { decrypt } = require("../services/secretCrypto");

const SLACK_NOTIFY_BRANCHES = new Set(["main", "master", "dev"]);

async function handleWebhook(req, res) {
  try {
    const signature = req.headers["x-hub-signature-256"];
    const body = req.body;

    if (!verifySignature(body, signature)) {
      return res.status(401).json({ message: "Invalid signature" });
    }

    const event = req.headers["x-github-event"];
    const payload = JSON.parse(body.toString());

    if (event === "installation" && payload.action === "created") {
      await handleInstallation(payload);
    } else if (
      event === "pull_request" &&
      (payload.action === "opened" || payload.action === "synchronize")
    ) {
      await handlePullRequest(payload);
      // TESTING: also fire the Slack notification on PR open so we can
      // exercise the flow without merging. Production behavior (notify on
      // merge to main/dev) still happens via the `closed && merged` branch
      // below. Remove this once testing is done.
      if (payload.action === "opened") {
        await sendPRSlackNotification(payload, "opened").catch((err) =>
          console.error("Test PR-open Slack notification failed:", err)
        );
      }
    } else if (
      event === "pull_request" &&
      payload.action === "closed" &&
      payload.pull_request?.merged === true
    ) {
      await handlePullRequestMerged(payload);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).json({ received: true });
  }
}

function verifySignature(body, signature) {
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET);
  const digest = "sha256=" + hmac.update(body).digest("hex");
  const sigBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);

  if (sigBuffer.length !== digestBuffer.length) return false;

  return crypto.timingSafeEqual(sigBuffer, digestBuffer);
}

async function handleInstallation(payload) {
  try {
    const { installation, repositories } = payload;

    const repos = (repositories || []).map((r) => ({
      repoName: r.name,
      repoFullName: r.full_name,
    }));

    await Installation.findOneAndUpdate(
      { installationId: installation.id },
      {
        installationId: installation.id,
        accountLogin: installation.account.login,
        accountType: installation.account.type,
        repos,
        installedAt: new Date(),
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error("Error saving installation:", err);
  }
}

// Path filters live here because the PR sync also needs them — we only
// touch docs for files that look API-ish, same rules as the backfill.
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
function isApiCandidate(filename) {
  return (
    hasSourceExtension(filename) &&
    !isExcludedPath(filename) &&
    hasApiPathHint(filename)
  );
}

/**
 * Sync docs for a single file changed in a PR.
 * - removed: delete every doc that originated from this file
 * - renamed: move docs from previous_filename, then re-extract under new name
 * - added/modified: re-extract endpoints from the NEW content and upsert.
 *   Any existing doc from this file whose {method,path} is not in the new
 *   list gets deleted (endpoint was removed or renamed within the file).
 */
async function syncFileDocs({
  octokit,
  owner,
  repo,
  headSha,
  file,
  mountContext,
  prNumber,
  userId,
  companyId,
}) {
  const result = {
    file: file.filename,
    status: file.status,
    added: 0,
    updated: 0,
    removed: 0,
    tokensInput: 0,
    tokensOutput: 0,
  };

  // --- Case 1: file fully removed ---
  if (file.status === "removed") {
    const del = await Doc.deleteMany({
      owner,
      repo,
      sourceFile: file.filename,
    });
    result.removed = del.deletedCount || 0;
    return result;
  }

  // --- Case 2: rename. Move existing docs under new filename first. ---
  if (file.status === "renamed" && file.previous_filename) {
    await Doc.updateMany(
      { owner, repo, sourceFile: file.previous_filename },
      { $set: { sourceFile: file.filename } }
    );
  }

  // If the new filename doesn't look like an API file, nothing else to do.
  if (!isApiCandidate(file.filename)) return result;

  // --- Case 3: added / modified / renamed-to-api — fetch new content ---
  let content;
  try {
    content = await fetchFileAtRef(octokit, owner, repo, file.filename, headSha);
  } catch (err) {
    console.error(`PR sync: could not read ${file.filename}:`, err.message);
    return result;
  }
  if (!content) return result;
  if (content.length > MAX_FILE_BYTES) {
    console.warn(`PR sync: skipping oversized ${file.filename}`);
    return result;
  }
  if (!fileLooksLikeApi(content)) {
    // If it used to contain routes and doesn't anymore, clean up stale docs.
    const del = await Doc.deleteMany({ owner, repo, sourceFile: file.filename });
    result.removed = del.deletedCount || 0;
    return result;
  }

  const { endpoints, usage } = await generateDocsFromFile({
    filePath: file.filename,
    content,
    mountContext,
  });
  result.tokensInput = usage.inputTokens;
  result.tokensOutput = usage.outputTokens;

  // Upsert new/updated endpoints keyed by {method, path}.
  if (endpoints.length) {
    const ops = endpoints.map((ep) => ({
      updateOne: {
        filter: { method: ep.method, path: ep.path, repo, owner },
        update: {
          $set: {
            ...ep,
            prNumber,
            repo,
            owner,
            userId,
            companyId,
            source: "pr",
            sourceFile: file.filename,
            sourceSha: file.sha,
            updatedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));
    const bulk = await Doc.bulkWrite(ops);
    result.added = bulk.upsertedCount || 0;
    result.updated = bulk.modifiedCount || 0;
  }

  // Delete docs from this file that are NOT in the new endpoint list —
  // those endpoints were removed or renamed in this PR.
  const liveKeys = endpoints.map((ep) => ({ method: ep.method, path: ep.path }));
  const delQuery = {
    owner,
    repo,
    sourceFile: file.filename,
  };
  if (liveKeys.length > 0) {
    delQuery.$nor = liveKeys;
  }
  const del = await Doc.deleteMany(delQuery);
  result.removed = del.deletedCount || 0;

  return result;
}

async function handlePullRequest(payload) {
  try {
    const { installation, pull_request, repository } = payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const prNumber = pull_request.number;
    const headSha = pull_request.head.sha;

    const installationRecord = await Installation.findOne({
      installationId: installation.id,
    });
    const userId = installationRecord?.userId || null;
    let companyId = installationRecord?.companyId || null;
    if (!companyId && userId) {
      const user = await User.findById(userId).select("companyId");
      companyId = user?.companyId || null;
    }

    const octokit = await getOctokit(installation.id);

    // 1) Test cases (old flow) — still off the diff, posted as a PR comment.
    // DISABLED FOR TESTING to save OpenAI tokens — uncomment to re-enable.
    // const diffPromise = getPRDiff(octokit, owner, repo, prNumber)
    //   .then((diff) => (diff ? generateTestCases(diff) : null))
    //   .catch((err) => {
    //     console.error("Test case generation failed:", err);
    //     return null;
    //   });

    // 2) Docs sync per file — each file is added/modified/removed/renamed
    //    explicitly so we can add, update or delete docs accordingly.
    // DISABLED FOR TESTING to save Opus 4.7 tokens — uncomment to re-enable.
    // const [prFiles, mountContext] = await Promise.all([
    //   getPRFiles(octokit, owner, repo, prNumber),
    //   fetchMountContextAtRef(octokit, owner, repo, headSha),
    // ]);
    //
    // const results = [];
    // for (const file of prFiles) {
    //   // Renames & removals can affect docs even if the new name isn't an
    //   // API candidate, so we enter syncFileDocs for every file.
    //   try {
    //     const r = await syncFileDocs({
    //       octokit,
    //       owner,
    //       repo,
    //       headSha,
    //       file,
    //       mountContext,
    //       prNumber,
    //       userId,
    //       companyId,
    //     });
    //     results.push(r);
    //   } catch (err) {
    //     console.error(`PR sync failed for ${file.filename}:`, err.message);
    //   }
    // }
    //
    // const totals = results.reduce(
    //   (acc, r) => ({
    //     added: acc.added + r.added,
    //     updated: acc.updated + r.updated,
    //     removed: acc.removed + r.removed,
    //     tokensInput: acc.tokensInput + r.tokensInput,
    //     tokensOutput: acc.tokensOutput + r.tokensOutput,
    //   }),
    //   { added: 0, updated: 0, removed: 0, tokensInput: 0, tokensOutput: 0 }
    // );
    //
    // console.log(
    //   `PR #${prNumber} docs sync:`,
    //   JSON.stringify({ ...totals, files: results.length })
    // );

    // 3) Post test cases as a comment once they're ready.
    // DISABLED FOR TESTING (see step 1 above) — uncomment to re-enable.
    // const testCases = await diffPromise;
    // if (testCases) {
    //   await commentOnPR(octokit, owner, repo, prNumber, testCases);
    // }
  } catch (err) {
    console.error("Error handling pull_request event:", err);
  }
}

async function sendPRSlackNotification(payload, eventType) {
  const { installation, pull_request, repository } = payload;
  const baseBranch = pull_request?.base?.ref;
  if (!baseBranch || !SLACK_NOTIFY_BRANCHES.has(baseBranch)) return;

  const installationRecord = await Installation.findOne({
    installationId: installation.id,
  });
  if (!installationRecord) return;

  let companyId = installationRecord.companyId;
  if (!companyId) {
    if (!installationRecord.userId) return;
    const user = await User.findById(installationRecord.userId).select("companyId");
    if (!user?.companyId) return;
    companyId = user.companyId;
  }

  const company = await Company.findById(companyId).select(
    "slackChannelId slackBotTokenEncrypted"
  );
  if (!company?.slackChannelId || !company?.slackBotTokenEncrypted) return;

  const botToken = decrypt(company.slackBotTokenEncrypted);
  if (!botToken) return;

  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pull_request.number;
  const octokit = await getOctokit(installation.id);
  const diff = await getPRDiff(octokit, owner, repo, prNumber).catch((err) => {
    console.error(`Failed to fetch diff for ${eventType} PR:`, err);
    return "";
  });

  let summary = null;
  let summaryError = null;
  try {
    summary = await summarizePR({
      diff: diff || "",
      title: pull_request.title,
      author: pull_request.user?.login,
      prNumber,
      baseBranch,
      prUrl: pull_request.html_url,
    });
  } catch (err) {
    summaryError = err?.message || String(err);
    console.error("summarizePR failed:", err);
  }

  const actionLine =
    eventType === "merged"
      ? `merged into \`${baseBranch}\` by`
      : `opened against \`${baseBranch}\` by`;
  const headerLine = `*${repository.full_name}* — PR <${pull_request.html_url}|#${prNumber} ${pull_request.title}> ${actionLine} ${pull_request.user?.login || "unknown"}`;

  // TESTING: surface why the AI summary is missing directly in Slack so we
  // can debug without scraping server logs. Remove this once it works.
  let body;
  if (summary && summary.trim()) {
    body = summary.trim();
  } else if (summaryError) {
    body = `_(no AI summary — error: ${summaryError})_`;
  } else if (!diff || !diff.trim()) {
    body = `_(no AI summary — PR diff was empty)_`;
  } else {
    body = `_(no AI summary — Claude returned empty text; diff was ${diff.length} chars)_`;
  }
  const text = `${headerLine}\n\n${body}`;

  await postSlackMessage({
    botToken,
    channelId: company.slackChannelId,
    text,
  });
}

async function handlePullRequestMerged(payload) {
  try {
    await sendPRSlackNotification(payload, "merged");
  } catch (err) {
    console.error("Error handling merged pull_request event:", err);
  }
}

module.exports = { handleWebhook };
