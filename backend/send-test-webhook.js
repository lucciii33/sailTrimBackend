#!/usr/bin/env node
/**
 * Fires a SIGNED installation_repositories webhook at your local backend, so
 * you can test the "owner approved a repo but it never showed up" fix without
 * needing an org owner to approve anything.
 *
 * Usage (from the backend folder, so it picks up .env):
 *   node send-webhook.js <installationId> <accountLogin> [action]
 *
 * Example:
 *   node send-webhook.js 12345678 my-org added
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const crypto = require("crypto");

const [, , installationId, accountLogin, action = "added"] = process.argv;

if (!installationId || !accountLogin) {
  console.error("usage: node send-webhook.js <installationId> <accountLogin> [added|removed]");
  process.exit(1);
}

const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET missing — run this from the backend folder.");
  process.exit(1);
}

const url = process.env.WEBHOOK_URL || "http://localhost:5000/webhook";

// The handler re-reads the repo list from GitHub, so repositories_added here is
// only a trigger — what actually lands in Mongo is whatever the GitHub API says
// that installation can see right now.
const payload = JSON.stringify({
  action,
  installation: {
    id: Number(installationId),
    account: { login: accountLogin, type: "Organization" },
  },
  repository_selection: "selected",
  repositories_added: [],
  repositories_removed: [],
  requester: null,
  sender: { login: accountLogin, type: "User" },
});

const signature =
  "sha256=" + crypto.createHmac("sha256", secret).update(Buffer.from(payload)).digest("hex");

fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-GitHub-Event": "installation_repositories",
    "X-Hub-Signature-256": signature,
  },
  body: payload,
})
  .then(async (res) => {
    console.log(`${res.status} ${await res.text()}`);
    console.log("\nNow check the server log for a line starting with:");
    console.log("  [github webhook] installation_repositories/" + action);
  })
  .catch((err) => {
    console.error("Request failed:", err.message);
    process.exit(1);
  });
