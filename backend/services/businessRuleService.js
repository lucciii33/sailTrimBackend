const Anthropic = require("@anthropic-ai/sdk");
const BusinessRule = require("../model/BusinessRuleModel");
const aiUsage = require("./aiUsageService.js");
const { modelFor } = require("./modelRouter.js");
const prDiff = require("./prDiffService");

// The memory between tickets. After a merge Olivia proposes the business rules
// the diff implies; a person approves them; the approved ones go into every
// prompt that writes tests for that API.

// Enough to cover a real API without crowding out the endpoint spec.
const MAX_RULES_IN_PROMPT = 40;
const MAX_PROPOSALS_PER_MERGE = 10;

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "missing" });
  }
  return aiUsage.meter(_anthropic, { payer: "platform", action: "business_rules", surface: "api" });
}

/** The API a doc belongs to: a connected repo, or an imported project. */
function scopeOf(source) {
  if (source.owner && source.repo) {
    return { owner: source.owner, repo: source.repo };
  }
  if (source.projectId) return { projectId: source.projectId };
  return null;
}

function endpointKey(method, path) {
  return `${String(method || "").toUpperCase()} ${path}`;
}

/** Approved rules for one endpoint: its own, plus the ones for the whole API. */
async function rulesFor({ companyId, doc }) {
  const scope = scopeOf(doc);
  if (!companyId || !scope) return [];
  return BusinessRule.find({
    companyId,
    ...scope,
    status: "approved",
    $or: [
      { appliesTo: { $size: 0 } },
      { appliesTo: endpointKey(doc.method, doc.path) },
    ],
  })
    .sort({ updatedAt: -1 })
    .limit(MAX_RULES_IN_PROMPT)
    .lean();
}

/** The rules as a block for a test-writing prompt, or "" when there are none. */
function rulesNote(rules) {
  if (!rules?.length) return "";
  const lines = rules.map((r) => `- [${r.kind}] ${r.text}`);
  return (
    "\n\nBUSINESS RULES (approved by the team; the API must respect them):\n" +
    lines.join("\n") +
    "\nWrite cases that check these rules hold, and that try to break them. " +
    "A rule marked known_bug is a bug that happened before: check it hasn't come back."
  );
}

const PROPOSE_SYSTEM = `You are a senior QA engineer keeping a list of the BUSINESS RULES of an HTTP API: what it must and must not allow, independent of how it is coded.

You receive the diff of a merged pull request, the API's endpoints, and the rules already on the list. Propose the NEW rules this diff establishes or changes.

Kinds:
- "permission": who may do what ("only owners can delete a project").
- "state": allowed states and transitions ("a shipped order cannot be cancelled").
- "invariant": something that must always hold ("stock never goes below zero").
- "rule": any other business rule ("a coupon applies once per customer").
- "known_bug": a bug this diff fixes, worth checking it never comes back.

Return STRICT JSON only:
{"rules":[{"kind":"permission","text":"one plain sentence","appliesTo":["METHOD /path"],"evidence":"which file or change shows it"}]}

Rules for you:
- Only rules the diff clearly shows. Never guess.
- Business behaviour only: no code, no variable names, no implementation details.
- appliesTo uses keys copied exactly from the endpoint list, or [] if the rule is API-wide.
- Skip anything already on the list.
- At most ${MAX_PROPOSALS_PER_MERGE} rules. Return {"rules":[]} if the diff establishes none.`;

function parseRules(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed.rules) ? parsed.rules : [];
  } catch (_) {
    return [];
  }
}

function normalize(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * After a merge: ask the model which rules the diff establishes and save them
 * as proposals for a person to review. Returns the rules it saved.
 */
async function proposeFromDiff({
  companyId,
  scope,
  files,
  prNumber = null,
  endpoints = [],
  anthropicClient = null,
}) {
  if (!companyId || !scope || !files?.length) return [];
  const diffText = prDiff.buildDiffText(files);
  if (!diffText.trim()) return [];

  const existing = await BusinessRule.find({
    companyId,
    ...scope,
    status: { $in: ["approved", "proposed"] },
  })
    .select("text")
    .lean();

  const client = aiUsage.tag(anthropicClient || getAnthropic(), {
    action: "business_rules",
    surface: "api",
  });
  const resp = await client.messages.create({
    model: modelFor("diff"),
    max_tokens: 3000,
    system: PROPOSE_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `ENDPOINTS:\n${endpoints.join("\n") || "(none listed)"}\n\n` +
          `RULES ALREADY ON THE LIST:\n${existing.map((r) => `- ${r.text}`).join("\n") || "(none)"}\n\n` +
          `DIFF:\n${diffText}`,
      },
    ],
  });
  const text = (resp.content || []).map((b) => b.text || "").join("");

  const known = new Set(existing.map((r) => normalize(r.text)));
  const validKeys = new Set(endpoints);
  const fileNames = files.map((f) => f.filename).filter(Boolean).slice(0, 20);
  const toSave = [];
  for (const r of parseRules(text).slice(0, MAX_PROPOSALS_PER_MERGE)) {
    const ruleText = String(r.text || "").trim().slice(0, 500);
    if (!ruleText || known.has(normalize(ruleText))) continue;
    known.add(normalize(ruleText));
    toSave.push({
      companyId,
      ...scope,
      kind: BusinessRule.KINDS.includes(r.kind) ? r.kind : "rule",
      text: ruleText,
      appliesTo: (Array.isArray(r.appliesTo) ? r.appliesTo : []).filter((k) =>
        validKeys.has(k)
      ),
      status: "proposed",
      source: "olivia",
      evidence: {
        prNumber,
        files: fileNames,
        note: String(r.evidence || "").slice(0, 300),
      },
    });
  }
  return toSave.length ? BusinessRule.insertMany(toSave) : [];
}

const CRITERIA_RULES_SYSTEM = `You are a senior QA engineer keeping a list of the BUSINESS RULES of an HTTP API: lasting rules about what it must and must not allow.

You receive the acceptance criteria of one ticket and the rules already on the list (approved, proposed or rejected). Pick only the criteria that state a LASTING business rule worth checking on every future PR, and write each as one plain, general sentence.

Leave out:
- Test cases, not rules: "returns 404 for a product that doesn't exist", "include_items=false still returns ...".
- Field lists or response shapes: "the response includes units_to_minimum".
- Anything "unchanged" or "still works": regressions, not rules.
- Anything already on the list, even worded differently, or a narrower case of a rule on the list ("editable is false when cancelled" when "an order is editable unless cancelled" is there). Rejected rules were rejected on purpose: never propose them again.
- Two criteria saying the same thing: keep one.

Kinds: "permission", "state", "invariant", "rule".

Return STRICT JSON only:
{"rules":[{"kind":"state","text":"one plain sentence","appliesTo":["METHOD /path"]}]}
appliesTo uses keys copied from the criteria, or [] if the rule is API-wide. Return {"rules":[]} if none qualify.`;

/**
 * After a PR review: the acceptance criteria that state a lasting business
 * rule become proposed rules, so the next PRs are tested against them too.
 * Test cases, field lists and repeats of rules already on the list are left
 * out. Proposed, never approved: a person decides. Returns the rules it saved.
 */
async function proposeFromCriteria({
  companyId,
  scope,
  criteria,
  prNumber = null,
  anthropicClient = null,
}) {
  const testable = (criteria || []).filter((c) => c.testable !== "manual" && c.text);
  if (!companyId || !scope || !testable.length) return [];
  const existing = await BusinessRule.find({ companyId, ...scope }).select("text status").lean();

  const client = aiUsage.tag(anthropicClient || getAnthropic(), {
    action: "business_rules",
    surface: "api",
  });
  const resp = await client.messages.create({
    model: modelFor("diff"),
    max_tokens: 2000,
    system: CRITERIA_RULES_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `RULES ALREADY ON THE LIST:\n${
            existing.map((r) => `- [${r.status}] ${r.text}`).join("\n") || "(none)"
          }\n\n` +
          `ACCEPTANCE CRITERIA:\n${testable
            .map((c) => `- ${c.text}${c.endpoints?.length ? ` (${c.endpoints.join(", ")})` : ""}`)
            .join("\n")}`,
      },
    ],
  });
  const text = (resp.content || []).map((b) => b.text || "").join("");

  const known = new Set(existing.map((r) => normalize(r.text)));
  const validKeys = new Set(testable.flatMap((c) => c.endpoints || []));
  const toSave = [];
  for (const r of parseRules(text).slice(0, MAX_PROPOSALS_PER_MERGE)) {
    const ruleText = String(r.text || "").trim().slice(0, 500);
    if (!ruleText || known.has(normalize(ruleText))) continue;
    known.add(normalize(ruleText));
    toSave.push({
      companyId,
      ...scope,
      kind: BusinessRule.KINDS.includes(r.kind) ? r.kind : "rule",
      text: ruleText,
      appliesTo: (Array.isArray(r.appliesTo) ? r.appliesTo : []).filter((k) => validKeys.has(k)),
      status: "proposed",
      source: "olivia",
      evidence: { prNumber, files: [], note: "From the PR's acceptance criteria" },
    });
  }
  return toSave.length ? BusinessRule.insertMany(toSave) : [];
}

/** The approved rules as Markdown, for a team that wants them in their repo. */
function toMarkdown(rules, title) {
  const byKind = {};
  for (const r of rules) (byKind[r.kind] = byKind[r.kind] || []).push(r);
  const headings = {
    permission: "Permissions",
    state: "States and transitions",
    invariant: "Invariants",
    rule: "Business rules",
    known_bug: "Bugs that must not come back",
  };
  let md = `# ${title}\n`;
  for (const kind of BusinessRule.KINDS) {
    if (!byKind[kind]) continue;
    md += `\n## ${headings[kind]}\n\n`;
    for (const r of byKind[kind]) {
      const where = r.appliesTo?.length ? ` (${r.appliesTo.join(", ")})` : "";
      md += `- ${r.text}${where}\n`;
    }
  }
  return md;
}

module.exports = {
  scopeOf,
  rulesFor,
  rulesNote,
  proposeFromDiff,
  proposeFromCriteria,
  toMarkdown,
  MAX_RULES_IN_PROMPT,
};
