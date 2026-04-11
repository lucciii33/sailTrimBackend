let githubApp;

async function getApp() {
  if (!githubApp) {
    const { App } = await import("@octokit/app");
    githubApp = new App({
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_PRIVATE_KEY
        ? Buffer.from(process.env.GITHUB_PRIVATE_KEY, "base64").toString("utf8")
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
  "server",
  "app",
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

const ROUTE_REGEX =
  /(router|app|fastify|server)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(|@(Get|Post|Put|Patch|Delete)\s*\(/i;

function isExcludedPath(filePath) {
  const parts = filePath.split("/");
  return parts.some((part) => EXCLUDED_DIRS.includes(part)) ||
    filePath.endsWith(".min.js") ||
    /\.(test|spec)\.[jt]sx?$/.test(filePath);
}

function hasApiPathHint(filePath) {
  const lower = filePath.toLowerCase();
  return API_PATH_HINTS.some((hint) => lower.includes(hint));
}

function hasSourceExtension(filePath) {
  return SOURCE_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

async function getDefaultBranch(octokit, owner, repo) {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}", {
    owner,
    repo,
  });
  return data.default_branch;
}

async function scanRepoForApiFiles(octokit, owner, repo) {
  const branch = await getDefaultBranch(octokit, owner, repo);

  const { data: branchData } = await octokit.request(
    "GET /repos/{owner}/{repo}/branches/{branch}",
    { owner, repo, branch },
  );
  const treeSha = branchData.commit.commit.tree.sha;

  const { data: tree } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    { owner, repo, tree_sha: treeSha, recursive: "1" },
  );

  return tree.tree
    .filter((node) => node.type === "blob")
    .filter((node) => hasSourceExtension(node.path))
    .filter((node) => !isExcludedPath(node.path))
    .filter((node) => hasApiPathHint(node.path))
    .map((node) => ({ path: node.path, sha: node.sha, size: node.size }));
}

async function fetchBlobContent(octokit, owner, repo, sha) {
  const { data } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
    { owner, repo, file_sha: sha },
  );
  if (data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf8");
  }
  return data.content;
}

function fileLooksLikeApi(content) {
  return ROUTE_REGEX.test(content);
}

module.exports = {
  getOctokit,
  getPRDiff,
  commentOnPR,
  scanRepoForApiFiles,
  fetchBlobContent,
  fileLooksLikeApi,
};
