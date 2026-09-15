// Gherkin has two shapes in this codebase and they have to stay in sync:
//   - gherkinText: the scenario as a human wrote or pasted it. Source of truth.
//     Steps interleave here (When → Then → And → When …), which is exactly what
//     the arrays below cannot express.
//   - gherkin.{feature,scenario,given,when,then}: the older structured view.
//     Still read by the UI's compact render and by anything grouping by step
//     kind, so every write to the text keeps it up to date.
// These two functions are the only place the conversion lives.

const KEYWORDS = ["given", "when", "then", "and", "but"];
const MAX_LINES = 60;
const MAX_LINE_LEN = 500;

// Structured case (from Claude's video generation) -> the text a user edits.
function gherkinToText(g = {}) {
  const lines = [];
  if (g.feature) lines.push(`Feature: ${g.feature}`);
  if (g.scenario) lines.push(`Scenario: ${g.scenario}`);
  (g.given || []).forEach((s) => lines.push(`  Given ${s}`));
  (g.when || []).forEach((s) => lines.push(`  When ${s}`));
  (g.then || []).forEach((s) => lines.push(`  Then ${s}`));
  return lines.join("\n");
}

// The pasted text -> the structured view. `And`/`But` inherit the previous
// keyword, and a bare line with no keyword at all does too, so a loosely pasted
// scenario still lands in the right bucket instead of being dropped.
// Order across buckets IS lost here; that's why gherkinText stays authoritative.
function parseGherkinText(text) {
  const out = { feature: "", scenario: "", given: [], when: [], then: [] };
  if (!text || typeof text !== "string") return out;

  let bucket = null; // "given" | "when" | "then"
  for (const raw of text.split(/\r?\n/).slice(0, MAX_LINES)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const header = line.match(/^(feature|scenario(?:\s+outline)?)\s*:\s*(.*)$/i);
    if (header) {
      const key = header[1].toLowerCase().startsWith("feature")
        ? "feature"
        : "scenario";
      if (!out[key]) out[key] = header[2].trim().slice(0, 300);
      continue;
    }

    const step = line.match(/^(\*|[a-zA-Z]+)\s+(.*)$/);
    const word = step ? step[1].toLowerCase() : "";
    if (KEYWORDS.includes(word)) {
      // And/But continue whatever came before; a leading And with no prior
      // step is treated as a Given.
      if (word === "and" || word === "but") bucket = bucket || "given";
      else bucket = word;
      pushStep(out, bucket, step[2]);
      continue;
    }

    // No recognizable keyword: keep it in the current bucket rather than
    // silently losing the line.
    pushStep(out, bucket || "given", line);
  }
  return out;
}

function pushStep(out, bucket, value) {
  const step = String(value || "").trim().slice(0, MAX_LINE_LEN);
  if (step) out[bucket].push(step);
}

module.exports = { gherkinToText, parseGherkinText };
