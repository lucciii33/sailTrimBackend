let githubApp;

function normalizePrivateKey(raw) {
  if (!raw) return "";
  let k = raw.trim();
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1);
  }
  if (k.includes("BEGIN") && k.includes("PRIVATE KEY")) {
    return k.replace(/\\n/g, "\n");
  }
  try {
    const decoded = Buffer.from(k, "base64").toString("utf8");
    if (decoded.includes("BEGIN") && decoded.includes("PRIVATE KEY")) {
      return decoded;
    }
  } catch (_) {}
  return k;
}

async function getApp() {
  if (!githubApp) {
    const { App } = await import("@octokit/app");
    githubApp = new App({
      appId: process.env.GITHUB_APP_ID,
      privateKey: normalizePrivateKey(process.env.GITHUB_PRIVATE_KEY),
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

// Path hints for files that define endpoints. "app"/"server" removed —
// they matched unrelated files (AppConfig.js, serverUtils.js). Entry
// files are detected separately via ENTRY_FILE_NAMES below.
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

// Entry files used to resolve mount prefixes across frameworks:
// - JS/TS: server.js, app.js, index.js (Express `app.use("/api", routes)`)
// - Python: main.py, app.py (FastAPI `app.include_router(prefix=...)`),
//           urls.py (Django `path("api/", include(...))`)
// - Ruby: routes.rb (Rails `namespace :api do`)
// - Go: main.go
// - PHP: web.php, api.php (Laravel `Route::prefix(...)`)
const ENTRY_FILE_NAMES = [
  "server.js", "app.js", "index.js", "main.js",
  "server.ts", "app.ts", "index.ts", "main.ts",
  "main.py", "app.py", "asgi.py", "wsgi.py", "urls.py",
  "routes.rb", "config/routes.rb",
  "main.go",
  "web.php", "api.php", "routes/web.php", "routes/api.php",
  "Program.cs", "Startup.cs",
];
const ENTRY_DIR_ALLOW = [
  "", "src", "backend", "api", "app", "server",
  "config", "routes",
  "cmd",
];

// Cap per-file size sent to the LLM. 200KB is already plenty for a routes file.
const MAX_FILE_BYTES = 200_000;

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

// Multi-framework route detection. Cheap pre-filter to skip files that
// obviously don't define endpoints. Anything matched is sent to the LLM,
// which makes the final call.
const ROUTE_REGEX = new RegExp(
  [
    // JS/TS: Express, Fastify, Koa, Hapi
    /(router|app|fastify|server|api)\s*\.\s*(get|post|put|patch|delete|options|head|all|use)\s*\(\s*["'`]/.source,
    // JS/TS decorators: NestJS / TS-controllers
    /@(Get|Post|Put|Patch|Delete|All|Controller|Route|Mapping|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(/.source,
    // Python: FastAPI / Flask / blueprints
    /@(app|router|api|bp|blueprint|[a-z_]+)\.(get|post|put|patch|delete|route|api_route|websocket)\s*\(/.source,
    /@api_view\s*\(/.source,
    // Python: Django urls
    /\b(path|re_path|url)\s*\(\s*r?["']/.source,
    // Ruby: Rails routes.rb / Sinatra
    /^\s*(get|post|put|patch|delete|match|resources|resource|namespace|scope)\s+["':]/m.source,
    // Go: Gin / Echo / Mux / chi / stdlib
    /\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|HandleFunc|Handle|Group|Route)\s*\(/.source,
    // PHP: Laravel / Symfony
    /Route::(get|post|put|patch|delete|any|match|resource|apiResource|prefix|group)\s*\(/.source,
    /#\[Route\s*\(/.source,
    // C#/.NET attributes
    /\[Http(Get|Post|Put|Patch|Delete)\s*[\(\]]/.source,
    /\[Route\s*\(/.source,
    // Rust: actix-web / axum / rocket macros
    /#\[(get|post|put|patch|delete|head|route)\s*\(/.source,
    // Java/Kotlin Spring
    /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\b/.source,
    // Elixir Phoenix
    /\b(get|post|put|patch|delete|resources)\s+"/.source,
  ].join("|"),
  "im"
);

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

function isEntryFileCandidate(filePath) {
  const parts = filePath.split("/");
  const name = parts[parts.length - 1];
  if (!ENTRY_FILE_NAMES.includes(name)) return false;
  // only accept if it's near the root to avoid noise
  const dir = parts.slice(0, -1).join("/");
  return ENTRY_DIR_ALLOW.includes(dir) || parts.length <= 2;
}

/**
 * Fetches the contents of entry files (server.js, app.js, …) so the LLM can
 * resolve mount prefixes like `app.use("/api/user", userRoutes)` and
 * document each endpoint with its full URL.
 */
async function fetchMountContext(octokit, owner, repo, treeNodes) {
  const entries = treeNodes
    .filter((n) => n.type === "blob" && isEntryFileCandidate(n.path))
    .slice(0, 5); // cap

  const out = [];
  for (const node of entries) {
    try {
      const content = await fetchBlobContent(octokit, owner, repo, node.sha);
      out.push({
        path: node.path,
        content: content.slice(0, 8_000), // first 8KB is enough for mount section
      });
    } catch (_) {
      /* skip unreadable entry files */
    }
  }
  return out;
}

// Path segments where schema/model definitions live across frameworks:
// - Python/FastAPI: schemas/, models/
// - Node/TS: dto/, dtos/, types/, interfaces/, models/, entities/
// - Java/Spring: dto/, entity/, model/
// - Go: model/, types/
// - Rails: app/models/
// - .NET: Models/, Dtos/, Entities/
const SCHEMA_PATH_SEGMENTS = new Set([
  "model", "models",
  "schema", "schemas",
  "dto", "dtos",
  "entity", "entities",
  "type", "types",
  "interface", "interfaces",
  "domain",
  "serializer", "serializers",
]);

function isSchemaCandidate(filePath) {
  const parts = filePath.toLowerCase().split("/");
  return parts.some((p) => SCHEMA_PATH_SEGMENTS.has(p));
}

/**
 * Pulls EVERY schema/model file in the repo. No global cap — works for any
 * repo size. Per-route filtering happens in the caller via
 * `pickSchemasForFile`, which only includes schemas actually referenced
 * by the route file. So a repo with 1000 schemas still costs little: each
 * Claude call only carries the handful of schemas its route imports.
 */
async function fetchSchemaContext(octokit, owner, repo, treeNodes) {
  const candidates = treeNodes
    .filter((n) => n.type === "blob")
    .filter((n) => hasSourceExtension(n.path))
    .filter((n) => !isExcludedPath(n.path))
    .filter((n) => isSchemaCandidate(n.path));

  const out = [];
  for (const node of candidates) {
    if (node.size && node.size > MAX_FILE_BYTES) continue;
    try {
      const content = await fetchBlobContent(octokit, owner, repo, node.sha);
      out.push({ path: node.path, content });
    } catch (_) {
      /* skip unreadable files */
    }
  }
  return out;
}

/**
 * Given a route file's content and the full repo-wide schema pool, return
 * only the schemas the route actually references. Heuristic: for each
 * schema file, if any of its class/type names (or its filename basename)
 * appears in the route content, include it. False positives are fine,
 * false negatives lose detail — so the matcher is intentionally loose.
 *
 * Detected definition keywords across languages:
 *   - Python: class
 *   - JS/TS: class, interface, type, enum
 *   - Java/Kotlin/C#/Scala: class, interface, record, enum, struct
 *   - Go: type X struct, type X interface
 *   - Ruby: class, module
 *   - Rust: struct, enum, trait
 */
const TYPE_DEF_REGEX =
  /\b(?:class|interface|type|enum|struct|record|trait|module)\s+([A-Z][A-Za-z0-9_]*)/g;

function basenameNoExt(p) {
  const file = p.split("/").pop() || "";
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

function pickSchemasForFile(routeContent, schemaContext) {
  if (!schemaContext || schemaContext.length === 0) return [];
  const out = [];
  for (const schema of schemaContext) {
    const names = new Set();
    names.add(basenameNoExt(schema.path));
    let m;
    TYPE_DEF_REGEX.lastIndex = 0;
    while ((m = TYPE_DEF_REGEX.exec(schema.content)) !== null) {
      names.add(m[1]);
    }
    for (const n of names) {
      if (!n) continue;
      // word-boundary match so "User" doesn't fire on "useRouter"
      const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(routeContent)) {
        out.push(schema);
        break;
      }
    }
  }
  return out;
}

async function scanRepoTree(octokit, owner, repo) {
  const branch = await getDefaultBranch(octokit, owner, repo);
  const { data: branchData } = await octokit.request(
    "GET /repos/{owner}/{repo}/branches/{branch}",
    { owner, repo, branch }
  );
  const treeSha = branchData.commit.commit.tree.sha;
  const { data: tree } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    { owner, repo, tree_sha: treeSha, recursive: "1" }
  );
  return tree.tree;
}

/**
 * PR webhook helpers
 * ------------------
 * We need per-file info (status, sha, previous_filename for renames) and
 * the ability to fetch the NEW content of each changed file so Claude
 * re-extracts the full endpoint list for that file.
 */
async function getPRFiles(octokit, owner, repo, prNumber) {
  const { data: files } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    { owner, repo, pull_number: prNumber, per_page: 100 }
  );
  return files; // each: {filename, status, sha, previous_filename?, patch?}
}

async function fetchFileAtRef(octokit, owner, repo, path, ref) {
  const { data } = await octokit.request(
    "GET /repos/{owner}/{repo}/contents/{path}",
    { owner, repo, path, ref }
  );
  if (Array.isArray(data)) return null; // it's a directory
  if (data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf8");
  }
  return data.content || null;
}

/**
 * Same as fetchMountContext but at an arbitrary ref (e.g. PR head sha).
 * Used so PR runs see server.js as it looks in the PR, not main.
 */
async function fetchMountContextAtRef(octokit, owner, repo, ref) {
  const out = [];
  for (const name of ENTRY_FILE_NAMES) {
    for (const dir of ENTRY_DIR_ALLOW) {
      const path = dir ? `${dir}/${name}` : name;
      try {
        const content = await fetchFileAtRef(octokit, owner, repo, path, ref);
        if (content) {
          out.push({ path, content: content.slice(0, 8_000) });
          break; // one hit per entry name is enough
        }
      } catch (_) {
        /* file not there at this path, try next */
      }
    }
    if (out.length >= 5) break;
  }
  return out;
}

module.exports = {
  getApp,
  getOctokit,
  getPRDiff,
  commentOnPR,
  fetchSchemaContext,
  pickSchemasForFile,
  scanRepoForApiFiles,
  scanRepoTree,
  fetchBlobContent,
  fetchMountContext,
  fileLooksLikeApi,
  getPRFiles,
  fetchFileAtRef,
  fetchMountContextAtRef,
  MAX_FILE_BYTES,
  SOURCE_EXTENSIONS,
};
