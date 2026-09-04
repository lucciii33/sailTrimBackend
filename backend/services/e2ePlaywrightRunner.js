const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Runs ONE generated spec with Playwright and reports whether it passed plus the
// failure output (fed back to Claude in the heal loop). The app under test is
// reached via E2E_BASE_URL (set from the project's baseUrl).
//
// The browser runs HEADLESS ON THIS HOST — deliberately not in Browserbase.
// Browserbase exists so a *human* can see and drive a browser (the login capture
// and the flow recorder); the heal loop has no human, it just executes a spec
// and reads the result. Routing it through Browserbase would burn a scarce
// cloud session per attempt (plan limit: 3 concurrent, 5 creations/minute) —
// four attempts from one user would starve everyone else. A local headless
// Chromium has no such ceiling and no per-session cost.
//
// This used to shell out into the sibling `oliviatools` checkout for
// @playwright/test and a config. Both now live in the backend (see
// e2e-runner/playwright.config.js), so the loop behaves identically on a laptop
// and on a deployed instance. Requires the browser binary:
//     npx playwright install chromium
// which must be part of the deploy's build step.
const RUNNER_DIR = path.resolve(__dirname, "../e2e-runner");
const CONFIG_PATH = path.join(RUNNER_DIR, "playwright.config.js");
// Specs are written here and deleted after the run. Kept out of the watched
// source tree so writing one can't restart a dev server mid-loop.
const SPEC_DIR = path.join(RUNNER_DIR, "specs");

// Prefer the locally installed binary over `npx`, which can wander off to the
// network on a cold deploy.
function playwrightBin() {
  const local = path.resolve(__dirname, "../node_modules/.bin/playwright");
  return fs.existsSync(local) ? local : "npx";
}

function safeParse(txt) {
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

// Start the recording already authenticated: inject `test.use({ storageState })`
// right after the @playwright/test import so the run reuses the project's saved
// login session. We only do this on the COPY that runs — the spec we return to
// the user stays clean (auth is environment-level, not part of the test).
function injectStorageState(spec, storagePath) {
  if (!storagePath) return spec;
  const use = `test.use({ storageState: ${JSON.stringify(storagePath)} });\n`;
  const m = spec.match(/^.*from\s+['"]@playwright\/test['"];?\s*$/m);
  if (m) {
    const at = spec.indexOf(m[0]) + m[0].length;
    return spec.slice(0, at) + "\n" + use + spec.slice(at);
  }
  return use + spec;
}

// Walk the Playwright JSON report and collect "<title>: <error message>" lines.
function summarizeFailures(json) {
  const lines = [];
  const visitSuite = (suite) => {
    (suite.suites || []).forEach(visitSuite);
    (suite.specs || []).forEach((spec) => {
      (spec.tests || []).forEach((t) => {
        (t.results || []).forEach((r) => {
          if (r.status === "passed" || r.status === "skipped") return;
          const errs = r.errors?.length ? r.errors : r.error ? [r.error] : [];
          const msg = errs
            .map((e) => e.message || e.value || "")
            .join("\n")
            .trim();
          lines.push(`✗ ${spec.title}\n${msg || `status: ${r.status}`}`);
        });
      });
    });
  };
  (json.suites || []).forEach(visitSuite);
  return lines.join("\n\n");
}

function runSpec(specCode, { baseUrl, storagePath, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const cwd = path.resolve(__dirname, "..");
    let file;
    try {
      fs.mkdirSync(SPEC_DIR, { recursive: true });
      file = path.join(SPEC_DIR, `_heal-${crypto.randomUUID()}.spec.ts`);
      fs.writeFileSync(file, injectStorageState(specCode, storagePath), "utf8");
    } catch (e) {
      return resolve({ passed: false, error: `Could not write spec: ${e.message}` });
    }

    const cleanup = () => fs.promises.unlink(file).catch(() => {});
    const env = { ...process.env };
    if (baseUrl) env.E2E_BASE_URL = baseUrl;

    // --reporter=json prints the report to stdout (overrides the config reporters
    // so we don't fight over test-results/results.json across concurrent runs).
    const bin = playwrightBin();
    const args = bin === "npx" ? ["playwright"] : [];
    const cp = spawn(
      bin,
      [...args, "test", file, "-c", CONFIG_PATH, "--reporter=json", "--workers=1"],
      { cwd, env }
    );

    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cp.kill("SIGKILL");
    }, timeoutMs);

    cp.stdout.on("data", (d) => (out += d.toString()));
    cp.stderr.on("data", (d) => (err += d.toString()));

    cp.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      resolve({
        passed: false,
        error:
          `Could not launch Playwright: ${e.message}. ` +
          `The deploy needs "npx playwright install chromium" in its build step.`,
      });
    });

    cp.on("close", () => {
      clearTimeout(timer);
      cleanup();
      if (timedOut) {
        return resolve({
          passed: false,
          error: `Test run timed out after ${timeoutMs / 1000}s.`,
        });
      }
      const json = safeParse(out);
      if (!json) {
        return resolve({
          passed: false,
          error: (err || out || "No output from Playwright.").slice(-4000),
        });
      }
      const stats = json.stats || {};
      const passed = (stats.unexpected || 0) === 0 && (stats.expected || 0) > 0;
      resolve({
        passed,
        error: passed ? "" : summarizeFailures(json).slice(-4000),
      });
    });
  });
}

module.exports = { runSpec };
