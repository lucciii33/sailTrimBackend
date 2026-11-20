// Sends this backend the webhook GitHub sends when a pull request is merged,
// built from a real, already merged PR. GitHub only notifies the deployed
// backend, so this is how a watcher (and its PR review) runs on a laptop.
//
//   node scripts/replayMerge.js <owner> <repo> <prNumber>
//
// Reads MONGO_URL, GITHUB_* and GITHUB_WEBHOOK_SECRET from .env. Posts to
// WEBHOOK_URL, default http://localhost:5000/webhook.
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");
const Installation = require("../model/Installation");
const { getOctokit } = require("../services/githubService");

async function main() {
  const [owner, repo, prNumber] = process.argv.slice(2);
  if (!owner || !repo || !Number(prNumber)) {
    throw new Error("Usage: node scripts/replayMerge.js <owner> <repo> <prNumber>");
  }
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is not set");

  await mongoose.connect(process.env.MONGO_URL);
  const installation = await Installation.findOne({
    "repos.repoFullName": `${owner}/${repo}`,
  }).lean();
  if (!installation) {
    throw new Error(`${owner}/${repo} isn't connected in this database`);
  }

  const octokit = await getOctokit(installation.installationId);
  const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: Number(prNumber),
  });
  if (!pr.merged_at) throw new Error(`PR #${prNumber} isn't merged`);

  const body = JSON.stringify({
    action: "closed",
    number: pr.number,
    pull_request: pr,
    repository: { name: repo, full_name: `${owner}/${repo}`, owner: { login: owner } },
    installation: { id: installation.installationId },
    sender: pr.merged_by || pr.user,
  });
  const signature =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

  const url = process.env.WEBHOOK_URL || "http://localhost:5000/webhook";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": crypto.randomUUID(),
      "X-Hub-Signature-256": signature,
    },
    body,
  });
  console.log(`PR #${pr.number} "${pr.title}" into ${pr.base.ref}: ${res.status} ${await res.text()}`);
  console.log("Watch the backend's terminal for [watcher] lines.");
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
