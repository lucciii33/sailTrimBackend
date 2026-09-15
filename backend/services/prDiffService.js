const Anthropic = require("@anthropic-ai/sdk");
const { getOctokit, getPRFiles } = require("./githubService");

// Which existing endpoints or tools did a merged PR actually TOUCH?
//
// The watchers already compare contracts (params, status codes, schemas), but a
// contract only moves for some changes. A new response field, a validation rule
// or a logic fix leaves it identical, and those endpoints went unlabeled. The
// diff is the one thing that knows what was touched, so read it and ask the
// model to map it onto the endpoints/tools that exist. Language-agnostic — no
// per-framework parsing.
//
// This ADDS to the contract comparison, it doesn't replace it: callers keep the
// contract result as a floor, so a param change is labeled even if the model
// misses it.

const MODEL = process.env.CLAUDE_QA_MODEL || "claude-opus-4-7";
const MAX_DIFF_CHARS = 60000;
const MAX_PATCH_CHARS = 12000;

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "missing" });
  }
  return _anthropic;
}

function safeParseJson(txt) {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (_) {
      return null;
    }
  }
}

async function fetchPRFiles({ installationId, owner, repo, prNumber }) {
  if (!installationId || !prNumber) return [];
  const octokit = await getOctokit(installationId);
  return getPRFiles(octokit, owner, repo, prNumber);
}

// Files with a textual patch, capped so one huge generated file can't crowd out
// the change that matters. Files GitHub gives no patch for (binaries, very large
// diffs) are named but not included.
function buildDiffText(files) {
  let out = "";
  for (const f of files || []) {
    const header = `### ${f.filename} (${f.status})\n`;
    if (!f.patch) {
      out += `${header}(no textual diff)\n\n`;
      continue;
    }
    const patch =
      f.patch.length > MAX_PATCH_CHARS
        ? `${f.patch.slice(0, MAX_PATCH_CHARS)}\n… [patch truncated]`
        : f.patch;
    out += `${header}\`\`\`diff\n${patch}\n\`\`\`\n\n`;
    if (out.length > MAX_DIFF_CHARS) {
      out = `${out.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated]`;
      break;
    }
  }
  return out;
}

const API_SYSTEM = `You receive the diff of a merged pull request and the list of HTTP endpoints that exist in the repository after the merge.

Decide which of THOSE endpoints this diff changed in any way: request params or body, response fields or shape, status codes, validation, business logic, or a helper whose behavior only affects that endpoint.

Return STRICT JSON only:
{"touched":[{"key":"<copied exactly from the list>","summary":"one short sentence describing what changed"}]}

Rules:
- Only use keys from the list, copied exactly.
- A change to shared code counts for an endpoint only if it clearly changes that endpoint's behavior.
- Do not include an endpoint just because the diff mentions it in a comment or test.
- Return {"touched":[]} if the diff doesn't change any listed endpoint.`;

const MCP_SYSTEM = `You receive the diff of a merged pull request and the list of MCP tools that existed on the server BEFORE the merge.

1) Decide which of THOSE tools this diff changed in any way: its parameters, validation, logic, or what it returns.
2) For each, say whether the change alters the tool's INTERFACE — its input parameters (names, types, required) or the shape of what it returns.
3) List any tool this diff newly DEFINES that is not in the list.
4) List any tool from the list this diff DELETES (its definition is removed).

Return STRICT JSON only:
{"touched":[{"key":"<tool name copied exactly from the list>","summary":"one short sentence","changesInterface":true}],"addedTools":["new_tool_name"],"removedTools":["deleted_tool_name"]}

Rules:
- "touched" keys must come from the list, copied exactly.
- A change to shared code counts for a tool only if it clearly changes that tool's behavior.
- Only count changes to the tool's OWN code on the MCP server (its definition, or a helper inside the MCP server that it calls). A change to an HTTP API endpoint, route or backend file that the tool calls does NOT count — even if the tool wraps that endpoint.
- Do not include a tool just because the diff mentions it in a comment or test.
- A deleted tool goes in "removedTools" ONLY, never in "touched".
- Return {"touched":[],"addedTools":[],"removedTools":[]} if the diff doesn't affect any tool.`;

/**
 * @param kind  "api" (items are "METHOD /path") or "mcp" (items are tool names)
 * @returns {{ touched: {key, summary, changesInterface?}[], addedTools: string[],
 *             removedTools: string[], analyzed: boolean }}
 *          `analyzed` is false when there was nothing to analyze or the call
 *          failed — callers treat that as "unknown", never as "nothing changed".
 */
async function findTouched({ files, items, kind, anthropicClient = null }) {
  const empty = { touched: [], addedTools: [], removedTools: [], analyzed: false };
  const diff = buildDiffText(files);
  if (!diff.trim() || !(items || []).length) return empty;

  const client = anthropicClient || getAnthropic();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: kind === "mcp" ? MCP_SYSTEM : API_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `${kind === "mcp" ? "TOOLS" : "ENDPOINTS"}:\n${items.join("\n")}\n\n` +
          `PULL REQUEST DIFF:\n${diff}`,
      },
    ],
  });
  const text = (resp?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = safeParseJson(text);
  if (!parsed) return empty;

  // Never trust a key the model made up — only what we actually listed.
  const allowed = new Set(items);
  const touched = (Array.isArray(parsed.touched) ? parsed.touched : [])
    .filter((t) => t && allowed.has(t.key))
    .map((t) => ({
      key: t.key,
      summary: String(t.summary || "").trim(),
      changesInterface: t.changesInterface === true,
    }));
  const addedTools = (Array.isArray(parsed.addedTools) ? parsed.addedTools : [])
    .map((n) => String(n || "").trim())
    .filter((n) => n && !allowed.has(n));
  // A deleted tool can only be one that existed before, so it must be a listed
  // key — same rule as `touched`.
  const removedTools = (Array.isArray(parsed.removedTools) ? parsed.removedTools : [])
    .map((n) => String(n || "").trim())
    .filter((n) => n && allowed.has(n));

  return { touched, addedTools, removedTools, analyzed: true };
}

module.exports = { fetchPRFiles, buildDiffText, findTouched };
