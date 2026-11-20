const path = require("path");

// Lazy-required: web-tree-sitter (+ its WASM grammar) is only needed when a
// backfill job actually parses a Python entry file. Requiring it eagerly at
// module load time — this file is required from server.js's route chain on
// every boot — measurably slowed down app startup. Load once, on first use.
let webTreeSitter = null;
function getWebTreeSitter() {
  if (!webTreeSitter) webTreeSitter = require("web-tree-sitter");
  return webTreeSitter;
}

const WASM_PATH = require.resolve("tree-sitter-wasms/out/tree-sitter-python.wasm");

let languagePromise = null;
async function loadPythonLanguage() {
  if (!languagePromise) {
    const { Parser, Language } = getWebTreeSitter();
    languagePromise = Parser.init().then(() => Language.load(WASM_PATH));
  }
  return languagePromise;
}

const ROUTER_MOUNT_CALLS = new Set(["include_router", "register_blueprint"]);
const PREFIX_KWARGS = new Set(["prefix", "url_prefix"]);

function stringLiteralValue(node) {
  if (!node || node.type !== "string") return null;
  const contentNode = node.namedChildren.find((c) => c.type === "string_content");
  return contentNode ? contentNode.text : null;
}

// Same dotted-module -> repo-relative-path resolution as the regex-based
// Python extractor in githubService.js (kept local here to avoid a
// circular require between the two modules). Returns the single resolved
// path for a relative import, or null for an absolute one (ambiguous
// project root — caller adds both a baseDir-relative and root-relative
// candidate in that case).
function resolveDotted(baseDir, dotted) {
  const leadingDots = dotted.match(/^\.*/)[0].length;
  const remainder = dotted.slice(leadingDots).split(".").filter(Boolean);
  if (remainder.length === 0) return null;
  if (leadingDots > 0) {
    let dir = baseDir;
    for (let i = 1; i < leadingDots; i += 1) dir = path.posix.dirname(dir);
    return path.posix.normalize(path.posix.join(dir, ...remainder));
  }
  return path.posix.normalize(path.posix.join(baseDir, ...remainder));
}

function addDottedCandidates(mounted, baseDir, dotted) {
  const resolved = resolveDotted(baseDir, dotted);
  if (!resolved) return;
  mounted.add(resolved);
  if (!dotted.startsWith(".")) {
    const remainder = dotted.split(".").filter(Boolean);
    mounted.add(remainder.join("/")); // repo-root-relative guess
  }
}

/**
 * Real AST-based mount resolution for Python entry files (FastAPI/Flask
 * `include_router`/`register_blueprint`, Django `include()`), replacing
 * the regex heuristic for files this parses successfully. Structural
 * matching (a real `call` node with the right callee, not just the
 * substring "include(" anywhere) plus real import-alias resolution
 * (`from routes.user import router as user_router` correctly ties the
 * `user_router` identifier back to the `routes.user` module).
 *
 * Returns { mountedPaths: Set<string>, mountPrefixes: Map<string,string> }.
 * mountPrefixes is only populated for the single-hop, unambiguous case
 * (`include_router(x, prefix="...")` / `register_blueprint(x,
 * url_prefix="...")`) — Django's `include()` prefix isn't captured here
 * because the full prefix depends on recursively resolving the included
 * urls.py's own patterns, which this single-file parse can't see.
 */
async function extractPythonMounts(filePath, content) {
  const language = await loadPythonLanguage();
  const { Parser } = getWebTreeSitter();
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(content);

  const baseDir = path.posix.dirname(filePath);
  const mountedPaths = new Set();
  const mountPrefixes = new Map();

  // alias (local name bound in this file) -> dotted module string
  // (with leading dots preserved for relative imports)
  const aliasToModule = new Map();

  function walk(node) {
    if (node.type === "import_from_statement") {
      const children = node.namedChildren;
      const moduleNode = children[0];
      const moduleDotted = moduleNode.text; // includes leading dots if relative_import
      for (const target of children.slice(1)) {
        if (target.type === "aliased_import") {
          const localName = target.namedChildren[1]?.text; // alias
          if (localName) aliasToModule.set(localName, moduleDotted);
        } else if (target.type === "dotted_name") {
          aliasToModule.set(target.text, moduleDotted);
        }
        // wildcard_import ("from x import *") — nothing to bind, skip.
      }
    } else if (node.type === "import_statement") {
      for (const target of node.namedChildren) {
        if (target.type === "aliased_import") {
          const original = target.namedChildren[0]?.text;
          const alias = target.namedChildren[1]?.text;
          if (alias && original) aliasToModule.set(alias, original);
        } else if (target.type === "dotted_name") {
          const firstSegment = target.namedChildren[0]?.text;
          if (firstSegment) aliasToModule.set(firstSegment, target.text);
        }
      }
    } else if (node.type === "call") {
      const fn = node.childForFieldName("function");
      const args = node.childForFieldName("arguments");
      if (fn && args) {
        const calleeName =
          fn.type === "attribute" ? fn.childForFieldName("attribute")?.text : fn.text;

        if (calleeName && ROUTER_MOUNT_CALLS.has(calleeName)) {
          const positional = args.namedChildren.find(
            (a) => a.type === "identifier" || a.type === "attribute"
          );
          const routerAlias =
            positional?.type === "identifier"
              ? positional.text
              : positional?.childForFieldName("object")?.text;
          const dotted = routerAlias ? aliasToModule.get(routerAlias) : null;

          let prefix;
          for (const arg of args.namedChildren) {
            if (arg.type !== "keyword_argument") continue;
            const name = arg.childForFieldName("name")?.text;
            if (name && PREFIX_KWARGS.has(name)) {
              const value = stringLiteralValue(arg.childForFieldName("value"));
              if (value !== null) prefix = value;
            }
          }

          if (dotted) {
            addDottedCandidates(mountedPaths, baseDir, dotted);
            if (prefix !== undefined) {
              // Resolve the same way addDottedCandidates does, to key the
              // prefix map with a path that's actually in mountedPaths.
              const resolved = resolveDotted(baseDir, dotted);
              if (resolved) mountPrefixes.set(resolved, prefix);
            }
          }
        } else if (calleeName === "include") {
          // Django: include("users.urls") — first positional string arg.
          const strArg = args.namedChildren.find((a) => a.type === "string");
          const value = stringLiteralValue(strArg);
          if (value) addDottedCandidates(mountedPaths, baseDir, value);
        }
      }
    }

    for (const child of node.namedChildren) walk(child);
  }

  walk(tree.rootNode);
  mountedPaths.delete(undefined);

  return { mountedPaths, mountPrefixes };
}

const PY_EXTENSIONS = new Set([".py"]);

module.exports = { extractPythonMounts, PY_EXTENSIONS };
