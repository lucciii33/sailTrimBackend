const path = require("path");

// Lazy-required: @babel/parser + @babel/traverse are only needed when a
// backfill job actually parses a JS/TS entry file, which is rare relative
// to server requests. Requiring them eagerly at module load time (this
// file is required from server.js's route chain on every boot) measurably
// slowed down app startup — enough to push borderline test timeouts over
// the edge. Load once, on first use.
let babelParse = null;
let babelTraverse = null;
function getBabel() {
  if (!babelParse) babelParse = require("@babel/parser").parse;
  if (!babelTraverse) {
    const traverseModule = require("@babel/traverse");
    babelTraverse = traverseModule.default || traverseModule;
  }
  return { parse: babelParse, traverse: babelTraverse };
}

const JS_TS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);

function pluginsFor(filePath) {
  const ext = path.posix.extname(filePath);
  if (ext === ".ts") return ["typescript"];
  if (ext === ".tsx") return ["jsx", "typescript"];
  return ["jsx"]; // .js/.jsx/.mjs/.cjs — JSX-in-JS is common even without TS
}

function parseJs(filePath, content) {
  const { parse } = getBabel();
  const basePlugins = pluginsFor(filePath);
  const attempts = [
    { sourceType: "unambiguous", plugins: basePlugins },
    { sourceType: "unambiguous", plugins: [...basePlugins, "decorators-legacy"] },
  ];
  let lastErr;
  for (const opts of attempts) {
    try {
      return parse(content, {
        ...opts,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        errorRecovery: true,
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function resolveRelative(baseDir, rel) {
  return path.posix.normalize(path.posix.join(baseDir, rel)).replace(/\.(jsx?|tsx?)$/i, "");
}

/**
 * Real AST-based mount resolution for JS/TS entry files, replacing the
 * regex heuristic for this language. Handles the patterns regex can't
 * reliably tell apart: variable indirection (`const r = require("./x");
 * app.use("/api", r)`), ES imports, and mount calls with extra middleware
 * arguments in between (`app.use("/webhook", express.raw(), require("./x"))`).
 *
 * Returns { mountedPaths: Set<string>, mountPrefixes: Map<string,string> }
 * — mountPrefixes maps a resolved module path to the literal prefix string
 * it's mounted at (empty string if mounted with no prefix), when we can
 * determine it with certainty (no LLM guessing needed for this part).
 * Throws on unparseable content — callers should fall back to regex.
 */
function extractJsMounts(filePath, content) {
  const { traverse } = getBabel();
  const ast = parseJs(filePath, content);
  const baseDir = path.posix.dirname(filePath);

  const localBindings = new Map(); // identifier name -> relative import path

  function recordBinding(name, rel) {
    if (name && rel && rel.startsWith(".")) localBindings.set(name, rel);
  }

  traverse(ast, {
    VariableDeclarator(nodePath) {
      const { id, init } = nodePath.node;
      if (
        id.type === "Identifier" &&
        init &&
        init.type === "CallExpression" &&
        init.callee.type === "Identifier" &&
        init.callee.name === "require" &&
        init.arguments[0]?.type === "StringLiteral"
      ) {
        recordBinding(id.name, init.arguments[0].value);
      }
    },
    ImportDeclaration(nodePath) {
      const source = nodePath.node.source.value;
      if (!source.startsWith(".")) return;
      for (const spec of nodePath.node.specifiers) {
        if (spec.local?.name) recordBinding(spec.local.name, source);
      }
    },
  });

  const mountedPaths = new Set();
  const mountPrefixes = new Map();

  function addMount(rel, prefix) {
    const resolved = resolveRelative(baseDir, rel);
    mountedPaths.add(resolved);
    if (prefix !== undefined && !mountPrefixes.has(resolved)) {
      mountPrefixes.set(resolved, prefix);
    }
  }

  traverse(ast, {
    CallExpression(nodePath) {
      const { callee, arguments: args } = nodePath.node;
      if (
        callee.type !== "MemberExpression" ||
        callee.property.type !== "Identifier" ||
        callee.property.name !== "use"
      ) {
        return;
      }

      let prefix;
      const moduleRefs = [];

      for (const arg of args) {
        if (arg.type === "StringLiteral" && prefix === undefined) {
          prefix = arg.value;
        } else if (
          arg.type === "CallExpression" &&
          arg.callee.type === "Identifier" &&
          arg.callee.name === "require" &&
          arg.arguments[0]?.type === "StringLiteral"
        ) {
          moduleRefs.push(arg.arguments[0].value);
        } else if (arg.type === "Identifier" && localBindings.has(arg.name)) {
          moduleRefs.push(localBindings.get(arg.name));
        }
      }

      for (const rel of moduleRefs) addMount(rel, prefix ?? "");
    },
  });

  return { mountedPaths, mountPrefixes };
}

module.exports = { extractJsMounts, JS_TS_EXTENSIONS };
