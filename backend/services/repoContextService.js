const Installation = require("../model/Installation");
const { getOctokit, scanRepoTree, fetchBlobContent } = require("./githubService");

// Builds a COMPACT, read-only snapshot of the front-end repo so Claude can
// rewrite a recorded test like a senior dev would: reuse existing helpers/page
// objects (DRY) and select by data-testids that actually exist. Nothing here is
// persisted — the repo is read at request time and the snapshot is thrown away
// after the call. The whole block is meant to be prompt-cached (stable across
// heal iterations for the same project), so keep it deterministic.
//
// Cost controls: support files (tests/helpers/page-objects) are sent in full but
// capped; every other component is scanned with a regex ONLY to harvest its
// data-testids — the file content is discarded, never sent.
const MAX_SUPPORT_FILES = 25; // full-text files (existing tests + helpers)
const MAX_FILE_CHARS = 8000; // per support file
const MAX_SCAN_FILES = 150; // components scanned for testids (regex only)
const MAX_TESTIDS = 400;
const MAX_CONTEXT_CHARS = 60000; // hard ceiling on the rendered block
const CONCURRENCY = 5;

const SUPPORT_HINTS = [
  "helper", "helpers", "util", "utils", "support",
  "fixture", "fixtures", "page-object", "pageobject", "pages",
  "selector", "selectors",
];
const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const TESTID_RE = /data-testid\s*=\s*["'`]([^"'`]+)["'`]/g;

function hasSourceExt(p) {
  return SOURCE_EXT.some((e) => p.endsWith(e));
}
function isExcluded(p) {
  return (
    /(^|\/)(node_modules|dist|build|\.next|coverage|\.git|public)(\/|$)/.test(p) ||
    p.endsWith(".d.ts")
  );
}
function looksLikeSupport(p, testDir) {
  const lower = p.toLowerCase();
  if (testDir && lower.startsWith(testDir.toLowerCase())) return true;
  return SUPPORT_HINTS.some((h) => lower.includes(h));
}

// Tiny bounded-concurrency map so a big repo doesn't fire hundreds of GitHub
// blob requests at once.
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const res = await Promise.all(batch.map(fn));
    res.forEach((r) => out.push(r));
  }
  return out;
}

// Find the GitHub App installation that can read this project's repo. Prefer the
// install whose repo list contains the repo; fall back to owner, then company.
async function resolveOctokit(project) {
  const companyId = project.companyId;
  const repo = project.github?.repo;
  const owner = project.github?.owner;
  if (!companyId || !repo || !owner) return null;
  const inst =
    (await Installation.findOne({ companyId, "repos.repoName": repo })) ||
    (await Installation.findOne({ companyId, accountLogin: owner })) ||
    (await Installation.findOne({ companyId }));
  if (!inst) return null;
  try {
    return await getOctokit(inst.installationId);
  } catch (_) {
    return null;
  }
}

// Returns { text, files, testIds }. text is "" when the repo can't be read —
// callers should treat repo context as best-effort and still improve the test.
async function buildRepoContext(project) {
  const owner = project.github?.owner;
  const repo = project.github?.repo;
  const testDir = (project.github?.testDir || "tests/e2e").replace(/\/+$/, "");
  if (!owner || !repo) return { text: "", files: 0, testIds: 0 };

  const octokit = await resolveOctokit(project);
  if (!octokit) return { text: "", files: 0, testIds: 0 };

  let tree;
  try {
    tree = await scanRepoTree(octokit, owner, repo);
  } catch (_) {
    return { text: "", files: 0, testIds: 0 };
  }

  const blobs = tree.filter(
    (n) => n.type === "blob" && hasSourceExt(n.path) && !isExcluded(n.path)
  );

  // 1) Support files (existing tests + helpers + page objects) — full text.
  const supportNodes = blobs
    .filter((n) => looksLikeSupport(n.path, testDir))
    .slice(0, MAX_SUPPORT_FILES);
  const supportFiles = (
    await mapLimit(supportNodes, CONCURRENCY, async (n) => {
      try {
        const content = await fetchBlobContent(octokit, owner, repo, n.sha);
        return { path: n.path, content: content.slice(0, MAX_FILE_CHARS) };
      } catch (_) {
        return null;
      }
    })
  ).filter(Boolean);

  // 2) Selector index — every other component scanned for data-testid (regex
  //    only; content discarded). This is the cheap "where do real testids live".
  const supportPaths = new Set(supportNodes.map((n) => n.path));
  const scanNodes = blobs
    .filter((n) => !supportPaths.has(n.path))
    .slice(0, MAX_SCAN_FILES);
  const testIdMap = new Map(); // testid -> first file it was seen in
  await mapLimit(scanNodes, CONCURRENCY, async (n) => {
    if (testIdMap.size >= MAX_TESTIDS) return;
    try {
      const content = await fetchBlobContent(octokit, owner, repo, n.sha);
      let m;
      TESTID_RE.lastIndex = 0;
      while ((m = TESTID_RE.exec(content)) !== null) {
        if (!testIdMap.has(m[1])) testIdMap.set(m[1], n.path);
        if (testIdMap.size >= MAX_TESTIDS) break;
      }
    } catch (_) {
      /* skip unreadable files */
    }
  });

  return {
    text: render(supportFiles, testIdMap),
    files: supportFiles.length,
    testIds: testIdMap.size,
  };
}

function render(supportFiles, testIdMap) {
  const parts = [];
  parts.push(
    "=== REPO CONTEXT (read-only reference for REUSE — do not restate it) ==="
  );

  const tests = supportFiles.filter((f) => /\.(spec|test)\./.test(f.path));
  const helpers = supportFiles.filter((f) => !/\.(spec|test)\./.test(f.path));

  if (helpers.length) {
    parts.push(
      "\n## Test helpers / page objects / fixtures — IMPORT and REUSE these instead of duplicating logic:"
    );
    for (const f of helpers) {
      parts.push(`\n### ${f.path}\n\`\`\`ts\n${f.content}\n\`\`\``);
    }
  }
  if (tests.length) {
    parts.push(
      "\n## Existing e2e tests — match their import paths, helpers and conventions:"
    );
    for (const f of tests) {
      parts.push(`\n### ${f.path}\n\`\`\`ts\n${f.content}\n\`\`\``);
    }
  }
  if (testIdMap.size) {
    parts.push(
      "\n## data-testid selectors that EXIST in the app (use getByTestId with these; never invent one not listed here or in an existing test):"
    );
    for (const [id, file] of testIdMap) parts.push(`- ${id}  (${file})`);
  }

  let text = parts.join("\n");
  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS) + "\n…(context truncated)…";
  }
  return text;
}

module.exports = { buildRepoContext };
