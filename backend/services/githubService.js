let githubApp;

async function getApp() {
  if (!githubApp) {
    const { App } = await import("@octokit/app");
    githubApp = new App({
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_PRIVATE_KEY
        ? process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n")
        : "",
      webhooks: { secret: process.env.GITHUB_WEBHOOK_SECRET },
    });
  }
  return githubApp;
}

async function getOctokit(installationId) {
  const app = await getApp();
  return app.getInstallationOctokit(installationId);
}

async function getPRDiff(octokit, owner, repo, prNumber) {
  const { data: files } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    {
      owner,
      repo,
      pull_number: prNumber,
    },
  );

  return files
    .filter((file) => file.patch)
    .map(
      (file) =>
        `### ${file.filename} (${file.status})\n\`\`\`diff\n${file.patch}\n\`\`\``,
    )
    .join("\n\n");
}

async function commentOnPR(octokit, owner, repo, prNumber, body) {
  await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner,
      repo,
      issue_number: prNumber,
      body: `## 🤖 QA Agent — Suggested Test Cases\n\n${body}`,
    },
  );
}

module.exports = { getOctokit, getPRDiff, commentOnPR };
