const crypto = require("crypto");
const Installation = require("../model/Installation");
const { getOctokit, getPRDiff, commentOnPR } = require("../services/githubService");
const { generateTestCases } = require("../services/aiService");
const { generateAndSaveDocs } = require("../services/docService");

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

async function handlePullRequest(payload) {
  try {
    const { installation, pull_request, repository } = payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const prNumber = pull_request.number;

    const octokit = await getOctokit(installation.id);
    const diff = await getPRDiff(octokit, owner, repo, prNumber);

    if (!diff) {
      console.error("No diff found for PR", prNumber);
      return;
    }

    const [testCases] = await Promise.all([
      generateTestCases(diff),
      generateAndSaveDocs(diff, prNumber, repo, owner),
    ]);
    await commentOnPR(octokit, owner, repo, prNumber, testCases);
  } catch (err) {
    console.error("Error handling pull_request event:", err);
  }
}

module.exports = { handleWebhook };
