// Converts the raw recorded events (from the cloud-browser recorder) into a
// Playwright spec — the SAME kind of `.spec.ts` codegen would produce. This is
// the seed spec; the heal service ([e2eHealService.js]) then rewrites it to
// senior quality against the repo and self-heals until green. The heal loop
// can't tell whether this seed came from codegen or from the cloud recorder —
// it's Playwright code either way.
function jsString(value) {
  return JSON.stringify(String(value == null ? "" : value));
}

// Prefer the most robust locator we can build from a captured event, in the
// same priority the heal prompt favors: testId > role+name > selector > text.
function locatorForAction(action) {
  if (action.testId) return `page.getByTestId(${jsString(action.testId)})`;
  if (action.role && action.text) {
    return `page.getByRole(${jsString(action.role)}, { name: ${jsString(action.text)} })`;
  }
  if (action.selector) return `page.locator(${jsString(action.selector)})`;
  if (action.text) return `page.getByText(${jsString(action.text)})`;
  return null;
}

function actionsToPlaywrightSpec({ title, actions }) {
  const safeTitle = String(title || "recorded flow").replace(/'/g, "\\'");
  const lines = [
    "import { test, expect } from '@playwright/test';",
    "",
    `test('${safeTitle}', async ({ page }) => {`,
  ];

  let lastUrl = "";
  for (const action of actions || []) {
    if (action.type === "navigate") {
      if (action.url && action.url !== lastUrl && /^https?:/.test(action.url)) {
        lines.push(`  await page.goto(${jsString(action.url)});`);
        lastUrl = action.url;
      }
      continue;
    }

    const locator = locatorForAction(action);
    if (!locator) continue;

    if (action.type === "click") {
      lines.push(`  await ${locator}.click();`);
    } else if (action.type === "fill") {
      if (action.sensitive) {
        // Never bake a captured password into the spec; the run injects it.
        lines.push(`  await ${locator}.fill(process.env.E2E_SECRET_VALUE || '');`);
      } else {
        lines.push(`  await ${locator}.fill(${jsString(action.value)});`);
      }
    }
  }

  // A recording with no assertion isn't a test; the heal step turns the Gherkin
  // "then" steps into real assertions, but seed with a minimal sanity check.
  lines.push("  await expect(page).toHaveURL(/.*/);");
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

module.exports = { actionsToPlaywrightSpec };
