const path = require("path");
const { extractJsMounts, JS_TS_EXTENSIONS } = require("./mountParsers/jsMountParser");
const { extractPythonMounts, PY_EXTENSIONS: AST_PY_EXTENSIONS } = require("./mountParsers/pythonMountParser");

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

// Commit a single file straight to a branch on GitHub via the Contents API.
// This writes the commit on the REMOTE (it's pushed + visible on GitHub
// immediately — no local clone). Creates the file or updates it in place when
// it already exists (we look up its current sha first). Returns the commit.
async function commitFileToBranch(octokit, { owner, repo, branch, path, content, message }) {
  // Updating an existing file needs its current blob sha; a 404 means it's new.
  let sha;
  try {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner, repo, path, ref: branch }
    );
    if (!Array.isArray(data)) sha = data.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  const { data } = await octokit.request(
    "PUT /repos/{owner}/{repo}/contents/{path}",
    {
      owner,
      repo,
      path,
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }
  );
  return {
    sha: data.commit?.sha,
    url: data.content?.html_url,
    branch,
    path,
  };
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

// Mount/prefix triggers, across frameworks. Used to make sure mount calls
// always reach the LLM even if they fall outside the head slice below
// (e.g. an entry file with routes registered near the bottom, after
// config/middleware setup).
const MOUNT_TRIGGER_REGEX =
  /(app|router|api)\s*\.\s*use\s*\(|include_router\s*\(|register_blueprint\s*\(|url_prefix|Route::\s*(prefix|group)\s*\(|^\s*namespace\s+:|\.\s*Group\s*\(|app\.Map(Get|Post|Put|Delete|Group)?\s*\(|(?<!\.)\bre_path\s*\(|(?<!\.)\binclude\s*\(|(?<!\.)\bpath\s*\(|^\s*scope\s+|^\s*resources?\s+/gim;

const MOUNT_HEAD_BYTES = 8_000; // covers imports/config context for small files
const MOUNT_MAX_BYTES = 20_000; // hard cap on what we send per entry file
const MOUNT_SNIPPET_WINDOW = 400; // chars captured after each trigger — mount calls are often split across several lines, e.g. `app.use(\n  "/webhook",\n  ...\n)`, so a per-line filter would keep the trigger line but drop the path on the next one

/**
 * Trims an entry file's content for the mount-context prompt: keeps the
 * head (imports/setup) plus a text window around every mount/prefix call
 * found anywhere in the file, so multi-line calls stay intact and calls
 * past the head cutoff aren't dropped once the file grows.
 */
function extractMountRelevantContent(content) {
  if (content.length <= MOUNT_HEAD_BYTES) return content;

  const head = content.slice(0, MOUNT_HEAD_BYTES);

  const ranges = [];
  const regex = new RegExp(MOUNT_TRIGGER_REGEX.source, MOUNT_TRIGGER_REGEX.flags);
  let match;
  while ((match = regex.exec(content)) !== null) {
    ranges.push([match.index, Math.min(content.length, match.index + MOUNT_SNIPPET_WINDOW)]);
    if (regex.lastIndex === match.index) regex.lastIndex += 1; // guard against zero-length matches
  }

  if (ranges.length === 0) return head;

  // Drop/clip anything already covered by the head slice, then merge
  // overlapping windows so we don't send duplicate text.
  const trimmed = ranges
    .map(([start, end]) => [Math.max(start, MOUNT_HEAD_BYTES), end])
    .filter(([start, end]) => start < end)
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const range of trimmed) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push(range);
    }
  }

  if (merged.length === 0) return head;

  const snippets = merged.map(([start, end]) => content.slice(start, end));
  const combined = `${head}\n\n// --- mount-relevant snippets from elsewhere in this file ---\n${snippets.join("\n...\n")}`;
  return combined.slice(0, MOUNT_MAX_BYTES);
}

// --- Orphan-route detection ------------------------------------------
//
// Only applies to ecosystems where a central entry file wires up a route
// module by referencing its path/module (Express require/import, FastAPI
// include_router, Django include()). Frameworks that route by convention or
// annotation — Rails (routes.rb maps to Controller#action by name, nothing
// to "require"), Spring (@RestController is classpath-scanned), ASP.NET
// attribute routing, NestJS decorators — have no equivalent failure mode: a
// route decorator is live the moment the framework scans the class, so
// there's no "file that exists but nothing mounts it" case to detect. For
// those, mountedPaths stays empty and isOrphanRouteFile safely no-ops
// (assumes mounted) rather than guessing.
//
// IMPORTANT — this is regex/heuristic matching, not a real parser (no AST)
// for any of these languages. It's solid for Express (the bug that
// prompted this) and reasonable best-effort for Django/FastAPI/Go. It will
// miss unusual import styles, dynamic mounts, or anything it doesn't have
// a pattern for — in which case it just no-ops (mounted stays true) rather
// than reporting a false orphan. Getting closer to 100% accurate for every
// framework would mean real AST parsing per language (JS/TS, Python,
// routes.rb, Go imports+router calls, Spring/ASP.NET annotation scanning)
// — a meaningfully bigger project than this fix. Don't advertise this as
// more than best-effort outside of Express.

// JS/TS: require("./x") / import ... from "./x" — relative specifiers only.
const JS_LOCAL_IMPORT_REGEX =
  /require\(\s*["'](\.[^"']+)["']\s*\)|from\s+["'](\.[^"']+)["']/g;

// Django: path("api/", include("users.urls")) / include('users.urls')
const DJANGO_INCLUDE_REGEX = /include\(\s*["']([\w.]+)["']/g;

// Python (FastAPI/Flask): tracks `from a.b import router [as alias]` so a
// later `include_router(alias)` / `register_blueprint(alias)` can be
// resolved back to the module it came from.
const PY_IMPORT_REGEX = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/gm;
const PY_MOUNT_CALL_REGEX = /(?:include_router|register_blueprint)\s*\(\s*(\w+)/g;

// Go: only local-looking quoted imports (path segment hints at routing) —
// we can't tell local packages from third-party ones without go.mod, so
// this stays a narrow, additive heuristic that can only make detection
// more lenient (add a "mounted" hit), never flag something as orphaned.
// Gated to .go files only (see extractMountedModulePaths) — the pattern is
// generic enough to false-match quoted strings in any other language.
const GO_LOCAL_IMPORT_REGEX = /"([\w./-]*(?:routes?|handlers?|api)[\w./-]*)"/gi;
const PY_EXTENSIONS = new Set([".py"]);
const GO_EXTENSIONS = new Set([".go"]);

function resolveDottedPythonModule(baseDir, dotted) {
  const leadingDots = dotted.match(/^\.*/)[0].length;
  const remainder = dotted.slice(leadingDots).split(".").filter(Boolean);
  if (leadingDots > 0) {
    // "." = current package, ".." = parent, etc.
    let dir = baseDir;
    for (let i = 1; i < leadingDots; i += 1) dir = path.posix.dirname(dir);
    return path.posix.normalize(path.posix.join(dir, ...remainder));
  }
  // Absolute import — we don't know the project's package root, so add
  // candidates both relative to the entry file's dir and to the repo root.
  return null; // handled by caller (needs two candidates, not one)
}

function addPythonDottedCandidates(mounted, baseDir, dotted) {
  const leadingDots = dotted.match(/^\.*/)[0].length;
  const remainder = dotted.slice(leadingDots).split(".").filter(Boolean);
  if (remainder.length === 0) return;
  if (leadingDots > 0) {
    mounted.add(resolveDottedPythonModule(baseDir, dotted));
  } else {
    mounted.add(path.posix.normalize(path.posix.join(baseDir, ...remainder)));
    mounted.add(remainder.join("/")); // repo-root-relative guess
  }
}

/**
 * For JS/TS entry files, tries the real AST parser first (see
 * jsMountParser.js) — exact, handles variable indirection and multi-line
 * calls regardless of file size. Falls back to the regex heuristic (on the
 * already-trimmed prompt content) if the file doesn't parse (syntax the
 * parser doesn't support, Flow types, etc.) so a parse failure degrades
 * gracefully instead of losing the entry entirely.
 */
function extractJsEntryMounts(entry) {
  const ext = path.posix.extname(entry.path);
  const empty = { mountedPaths: new Set(), mountPrefixes: new Map() };
  if (!JS_TS_EXTENSIONS.has(ext)) return empty;

  try {
    return extractJsMounts(entry.path, entry.rawContent ?? entry.content);
  } catch (_) {
    /* fall through to regex below — still JS/TS, just unparseable */
  }

  const mounted = new Set();
  const baseDir = path.posix.dirname(entry.path);
  const jsRegex = new RegExp(JS_LOCAL_IMPORT_REGEX.source, "g");
  let match;
  while ((match = jsRegex.exec(entry.content)) !== null) {
    const rel = match[1] || match[2];
    if (!rel) continue;
    mounted.add(
      path.posix.normalize(path.posix.join(baseDir, rel)).replace(/\.[jt]sx?$/, "")
    );
  }
  return { mountedPaths: mounted, mountPrefixes: new Map() };
}

/**
 * Django/FastAPI/Flask mount resolution via regex — gated to .py files only
 * (these patterns are Python-syntax-specific enough that they're unlikely
 * to false-match other languages, but we scope them anyway for clarity and
 * consistency with the other per-language extractors).
 */
/**
 * For Python entry files, tries the real AST parser first (see
 * pythonMountParser.js, tree-sitter-based) — exact, structural matching of
 * include_router/register_blueprint/include() plus real import-alias
 * resolution. Falls back to the regex heuristic if the file doesn't parse
 * or the WASM grammar fails to load.
 */
async function extractPythonEntryMounts(entry) {
  const ext = path.posix.extname(entry.path);
  const empty = { mountedPaths: new Set(), mountPrefixes: new Map() };
  if (!PY_EXTENSIONS.has(ext)) return empty;

  try {
    return await extractPythonMounts(entry.path, entry.rawContent ?? entry.content);
  } catch (_) {
    /* fall through to regex below — still Python, just unparseable */
  }

  const mounted = new Set();
  const baseDir = path.posix.dirname(entry.path);
  const content = entry.content;
  let match;

  const djangoRegex = new RegExp(DJANGO_INCLUDE_REGEX.source, "g");
  while ((match = djangoRegex.exec(content)) !== null) {
    addPythonDottedCandidates(mounted, baseDir, match[1]);
  }

  // Router/blueprint mounts: build alias -> dotted-module map from imports,
  // then resolve every include_router/register_blueprint call.
  const aliasToModule = new Map();
  const pyImportRegex = new RegExp(PY_IMPORT_REGEX.source, PY_IMPORT_REGEX.flags);
  while ((match = pyImportRegex.exec(content)) !== null) {
    const dotted = match[1];
    const names = match[2].split(",").map((s) => s.trim());
    for (const nameClause of names) {
      const asMatch = nameClause.match(/^(\w+)\s+as\s+(\w+)$/);
      const alias = asMatch ? asMatch[2] : nameClause.split(/\s+/)[0];
      if (alias) aliasToModule.set(alias, dotted);
    }
  }
  const pyMountRegex = new RegExp(PY_MOUNT_CALL_REGEX.source, "g");
  while ((match = pyMountRegex.exec(content)) !== null) {
    const dotted = aliasToModule.get(match[1]);
    if (dotted) addPythonDottedCandidates(mounted, baseDir, dotted);
  }

  return { mountedPaths: mounted, mountPrefixes: new Map() };
}

/** Go mount resolution via regex — gated to .go files only (see the note on
 * GO_LOCAL_IMPORT_REGEX: the pattern is generic enough to false-match
 * quoted strings in any other language, so it must never run over non-Go
 * content). */
function extractGoEntryMounts(entry) {
  const ext = path.posix.extname(entry.path);
  const mounted = new Set();
  if (!GO_EXTENSIONS.has(ext)) return mounted;

  const goRegex = new RegExp(GO_LOCAL_IMPORT_REGEX.source, "gi");
  let match;
  while ((match = goRegex.exec(entry.content)) !== null) {
    mounted.add(match[1]);
  }
  return mounted;
}

/**
 * Resolves every local route module referenced from the mount-context
 * snippets (e.g. `require("./routes/userRoutes")` inside `app.use(...)`,
 * or `include("users.urls")` inside Django's urlpatterns) to a
 * language-agnostic repo-relative path, stripped of extension. This is the
 * set of route files that are actually wired into the app. Each
 * per-language extractor only runs against files of its own language —
 * running e.g. the Go pattern over a JS file's content would false-match
 * unrelated quoted strings.
 */
async function extractMountedModulePaths(mountContext) {
  const mounted = new Set();
  for (const entry of mountContext || []) {
    const { mountedPaths: jsMounted } = extractJsEntryMounts(entry);
    for (const p of jsMounted) mounted.add(p);

    const { mountedPaths: pyMounted } = await extractPythonEntryMounts(entry);
    for (const p of pyMounted) mounted.add(p);

    for (const p of extractGoEntryMounts(entry)) mounted.add(p);
  }
  mounted.delete(null);
  return mounted;
}

/**
 * Resolved-path -> literal mount prefix, e.g. "backend/routes/userRoutes"
 * -> "/api/user". Only populated where we have deterministic signal (today:
 * JS/TS and Python entry files that parsed successfully via a real AST
 * parser — see jsMountParser.js / pythonMountParser.js) — these are facts,
 * not guesses, so callers can hand them to the LLM as ground truth instead
 * of asking it to infer the prefix from raw text. Empty for languages/files
 * we don't have a real parser for yet (or Django's include(), where the
 * true prefix depends on recursively resolving the included urls.py); the
 * LLM still gets the (regex-trimmed) mount-context text as before for those.
 */
async function extractMountPrefixes(mountContext) {
  const prefixes = new Map();
  for (const entry of mountContext || []) {
    const { mountPrefixes: jsPrefixes } = extractJsEntryMounts(entry);
    for (const [modulePath, prefix] of jsPrefixes) {
      if (!prefixes.has(modulePath)) prefixes.set(modulePath, prefix);
    }

    const { mountPrefixes: pyPrefixes } = await extractPythonEntryMounts(entry);
    for (const [modulePath, prefix] of pyPrefixes) {
      if (!prefixes.has(modulePath)) prefixes.set(modulePath, prefix);
    }
  }
  return prefixes;
}

// Heuristic for "this file's job is to be required/imported by an entry
// file and mounted" — as opposed to a controller/handler/model that's only
// ever required transitively (by a route file, not by the entry file
// itself), which would never show up in mount-context snippets even when
// properly wired.
function isRouteEntryFile(filePath) {
  const parts = filePath.split("/");
  const name = parts[parts.length - 1];
  return (
    parts.includes("routes") ||
    /^(routes?|router|urls)\.(js|ts|jsx|tsx|py|rb|go)$/i.test(name)
  );
}

/**
 * True when a route file's endpoints are real code but nothing in the app
 * ever mounts them — i.e. dead/unreachable routes. Only judges files that
 * look like route-entry files (see isRouteEntryFile); only returns true
 * when we actually resolved at least one mounted path from the entry
 * files, so a repo we have no mount signal for never gets false positives.
 */
function isOrphanRouteFile(filePath, mountedPaths) {
  if (!isRouteEntryFile(filePath)) return false;
  if (!mountedPaths || mountedPaths.size === 0) return false;

  const normalized = filePath.replace(/\.(jsx?|tsx?|py|rb|go)$/i, "");
  if (mountedPaths.has(normalized)) return false;

  // Absolute-import resolution (Python dotted imports, Go package paths)
  // can't always pin down the exact project root, so also accept a path
  // suffix match — biasing toward "assume mounted" when ambiguous rather
  // than risking a false orphan flag.
  for (const mountedPath of mountedPaths) {
    if (!mountedPath) continue;
    if (
      normalized === mountedPath ||
      normalized.endsWith(`/${mountedPath}`) ||
      mountedPath.endsWith(`/${normalized}`) ||
      // Go (and similar) import a whole package directory, not one file —
      // treat any file living inside that directory as mounted too.
      normalized.startsWith(`${mountedPath}/`)
    ) {
      return false;
    }
  }
  return true;
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
        content: extractMountRelevantContent(content),
        // Full content (capped), used by the real AST parsers — those
        // don't have the "truncation loses the mount line" problem the
        // regex/snippet approach above works around.
        rawContent: content.slice(0, MAX_FILE_BYTES),
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

// OpenAPI specs live in yaml/json. The user tells Olivia the file name; we
// scan the repo tree and return matching candidates (a name can exist in more
// than one folder, so we return a list and let the user confirm).
const SPEC_EXTENSIONS = [".yaml", ".yml", ".json"];

function looksLikeSpecPath(filePath) {
  const lower = filePath.toLowerCase();
  return SPEC_EXTENSIONS.some((e) => lower.endsWith(e));
}

/**
 * Find OpenAPI spec candidates in a repo by the file name the user gave.
 * Matches case-insensitively against the basename and the full path so
 * "openapi.yml" or "docs/openapi" both work. With no hint, returns every
 * spec-looking file so the user can pick.
 */
async function findSpecCandidates(octokit, owner, repo, filenameHint) {
  const tree = await scanRepoTree(octokit, owner, repo);
  const blobs = tree.filter(
    (n) => n.type === "blob" && !isExcludedPath(n.path)
  );
  const hint = (filenameHint || "").trim().toLowerCase();

  let matches;
  if (hint) {
    matches = blobs.filter((n) => {
      const lower = n.path.toLowerCase();
      const base = lower.split("/").pop();
      return lower.includes(hint) || base.includes(hint);
    });
  } else {
    matches = blobs.filter((n) => looksLikeSpecPath(n.path));
  }

  // Spec-extension files first, then shorter (shallower) paths.
  matches.sort((a, b) => {
    const sa = looksLikeSpecPath(a.path) ? 0 : 1;
    const sb = looksLikeSpecPath(b.path) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.path.length - b.path.length;
  });

  return matches
    .slice(0, 20)
    .map((n) => ({ path: n.path, sha: n.sha, size: n.size }));
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
          out.push({
            path,
            content: extractMountRelevantContent(content),
            rawContent: content.slice(0, MAX_FILE_BYTES),
          });
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
  findSpecCandidates,
  getDefaultBranch,
  commitFileToBranch,
  fetchBlobContent,
  fetchMountContext,
  fileLooksLikeApi,
  getPRFiles,
  fetchFileAtRef,
  fetchMountContextAtRef,
  extractMountedModulePaths,
  extractMountPrefixes,
  isOrphanRouteFile,
  MAX_FILE_BYTES,
  SOURCE_EXTENSIONS,
};
