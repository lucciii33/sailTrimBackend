const Anthropic = require("@anthropic-ai/sdk");
const Doc = require("../model/DocModel");

// Lazy init so a missing key doesn't crash module load.
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "missing",
    });
  }
  return _anthropic;
}

// Claude Opus 4.7 — Anthropic's most capable model. Use claude-sonnet-4-6
// for faster/cheaper runs if backfills get expensive.
const CLAUDE_MODEL = process.env.CLAUDE_DOCS_MODEL || "claude-opus-4-7";

// ---------- Prompt building ----------

const DOC_SYSTEM_PROMPT = `You are an API documentation generator.
You will be given:
  (A) Optional entry files (server.js, app.js, index.js) showing where sub-routers are mounted with app.use("/prefix", router).
  (B) A single source file that may define HTTP endpoints.

Your job: detect every HTTP endpoint in (B) and output its FULL URL, resolving any prefix from (A).

Return STRICT JSON only, starting with {, matching this exact shape:
{
  "endpoints": [
    {
      "method": "POST",
      "path": "/api/example/login",
      "description": "What this endpoint does (be specific, infer from handler logic if present)",
      "requestBody": [
        { "name": "fieldName", "type": "String", "required": true, "description": "what it is" }
      ],
      "queryParams": [
        { "name": "paramName", "type": "String", "required": false, "description": "what it is" }
      ],
      "responses": [
        { "status": 200, "description": "Success", "example": { "key": "value" } },
        { "status": 400, "description": "Error", "example": { "message": "error" } }
      ]
    }
  ]
}

Rules:
- If no endpoints exist, return {"endpoints": []}.
- ALWAYS resolve the mount prefix. Example: if server.js has app.use("/api/user", userRoutes) and the file has router.post("/login"), the path is "/api/user/login" — NEVER just "/login".
- Only document handler-based routes (express router/app .get/.post/.put/.patch/.delete, fastify, NestJS @Get/@Post decorators, etc.).
- Do not include middleware-only lines.`;

function buildMountContextBlock(mountContext) {
  if (!mountContext || mountContext.length === 0) return "(no entry files provided)";
  return mountContext
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
}

function buildUserMessage({ filePath, content, mountContext, diff }) {
  const mountBlock = buildMountContextBlock(mountContext);
  if (diff) {
    return `ENTRY FILES (for mount prefix resolution):\n${mountBlock}\n\nDIFF:\n${diff}`;
  }
  return `ENTRY FILES (for mount prefix resolution):\n${mountBlock}\n\nFILE: ${filePath}\n\`\`\`\n${content}\n\`\`\``;
}

function safeParseJson(txt) {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

// ---------- Core Claude call ----------

async function callClaudeForDocs({ filePath, content, mountContext, diff }) {
  const userMsg = buildUserMessage({ filePath, content, mountContext, diff });

  const response = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: DOC_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  const raw = (response.content || []).map((c) => c.text || "").join("");
  const parsed = safeParseJson(raw);
  const endpoints = parsed?.endpoints || [];

  const usage = {
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
    model: CLAUDE_MODEL,
  };

  return { endpoints, usage };
}

// ---------- Public API ----------

/**
 * PR-mode: called from webhook when a PR is opened/updated.
 * mountContext is optional — webhook flow currently doesn't scan the repo.
 */
async function generateAndSaveDocs(diff, prNumber, repo, owner, userId, mountContext = []) {
  const { endpoints, usage } = await callClaudeForDocs({ diff, mountContext });
  if (endpoints.length === 0) return { endpoints: [], usage };

  const ops = endpoints.map((ep) => ({
    updateOne: {
      filter: { method: ep.method, path: ep.path, repo, owner },
      update: {
        $set: {
          ...ep,
          prNumber,
          repo,
          owner,
          userId,
          source: "pr",
          updatedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await Doc.bulkWrite(ops);
  return { endpoints, usage };
}

/**
 * Backfill-mode: called per source file.
 * Returns { endpoints, usage } so the caller can aggregate token counts.
 */
async function generateDocsFromFile({ filePath, content, mountContext }) {
  return callClaudeForDocs({ filePath, content, mountContext });
}

async function saveBackfillDocs({
  endpoints,
  repo,
  owner,
  userId,
  sourceFile,
  sourceSha,
}) {
  if (!endpoints.length) return 0;

  const ops = endpoints.map((ep) => ({
    updateOne: {
      filter: { method: ep.method, path: ep.path, repo, owner },
      update: {
        $set: {
          ...ep,
          repo,
          owner,
          userId,
          source: "backfill",
          sourceFile,
          sourceSha,
          updatedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await Doc.bulkWrite(ops);
  return endpoints.length;
}

/**
 * Removes backfill docs for this repo whose sourceSha is no longer in
 * the latest scan — i.e. endpoints that no longer exist in the code.
 */
async function cleanupZombieDocs({ owner, repo, liveShas }) {
  if (!liveShas || liveShas.length === 0) return 0;
  const result = await Doc.deleteMany({
    owner,
    repo,
    source: "backfill",
    sourceSha: { $nin: liveShas },
  });
  return result.deletedCount || 0;
}

module.exports = {
  generateAndSaveDocs,
  generateDocsFromFile,
  saveBackfillDocs,
  cleanupZombieDocs,
  CLAUDE_MODEL,
};
