const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { uploadEvidence } = require("./aws");

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
// Playwright's outputDir (traces/screenshots), mirrored from playwright.config.js.
const ARTIFACT_DIR = path.join(RUNNER_DIR, "artifacts");

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

  // Top-level errors first. A spec that fails to COMPILE (TypeScript error, a
  // bad import, a syntax slip) is reported HERE, with zero suites — so walking
  // only `suites` returned an empty string and the heal loop handed Claude a
  // blank error to fix. It then had to guess at the next attempt, which is what
  // made attempt 1 look like a wasted round every time.
  for (const e of json.errors || []) {
    const msg = (e.message || e.value || "").trim();
    if (msg) lines.push(`\u2717 the spec never ran\n${msg}`);
  }

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

// Playwright records the trace as an attachment on the failing result. Pull the
// first one out of the report so we can ship it somewhere durable.
function findTracePath(json) {
  let found = "";
  const visitSuite = (suite) => {
    (suite.suites || []).forEach(visitSuite);
    (suite.specs || []).forEach((spec) => {
      (spec.tests || []).forEach((t) => {
        (t.results || []).forEach((r) => {
          for (const a of r.attachments || []) {
            if (!found && a.name === "trace" && a.path) found = a.path;
          }
        });
      });
    });
  };
  (json.suites || []).forEach(visitSuite);
  return found;
}

// This host's disk is ephemeral (a deploy wipes it), so a trace left on disk is
// worthless a day later. Push it to S3 and hand back a URL the heal log can
// keep. Best-effort on purpose: losing the trace must never turn a real test
// result into a failure.
async function uploadTrace(tracePath, { testId }) {
  if (!tracePath) return "";
  try {
    const buf = await fs.promises.readFile(tracePath);
    const name = `heal-${testId || "run"}-${Date.now()}.zip`;
    const { url } = await uploadEvidence(buf, name, "application/zip");
    return url || "";
  } catch (err) {
    console.error("[e2e] trace upload failed:", err.message);
    return "";
  }
}

// Playwright reported no failing test AND no error, yet nothing passed — most
// often the file produced zero tests. Say that plainly rather than sending an
// empty string down the loop.
function describeSilentFailure(stats) {
  if (!stats.expected && !stats.unexpected) {
    return (
      "Playwright ran but found NO tests in the file. The spec must define at " +
      "least one `test(...)` at the top level and import from '@playwright/test'."
    );
  }
  return "The run did not pass, but Playwright reported no error output.";
}

function runSpec(specCode, { baseUrl, storagePath, testId, timeoutMs = 120000 } = {}) {
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

    // Remove the spec AND the run's artifacts: the trace has already been
    // uploaded by then, and leaving them behind fills the disk one run at a time.
    const cleanup = () =>
      Promise.all([
        fs.promises.unlink(file).catch(() => {}),
        fs.promises.rm(ARTIFACT_DIR, { recursive: true, force: true }).catch(() => {}),
      ]);
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

    cp.on("close", async () => {
      clearTimeout(timer);
      if (timedOut) {
        await cleanup();
        return resolve({
          passed: false,
          error: `Test run timed out after ${timeoutMs / 1000}s.`,
        });
      }
      const json = safeParse(out);
      if (!json) {
        await cleanup();
        return resolve({
          passed: false,
          error: (err || out || "No output from Playwright.").slice(-4000),
        });
      }
      const stats = json.stats || {};
      const passed = (stats.unexpected || 0) === 0 && (stats.expected || 0) > 0;
      // PAUSED alongside trace capture in playwright.config.js — see the note
      // there. Uncomment this line (and re-enable trace there) to restore it;
      // findTracePath/uploadTrace below are left intact for that.
      // const traceUrl = passed ? "" : await uploadTrace(findTracePath(json), { testId });
      const traceUrl = "";
      await cleanup();
      resolve({
        passed,
        // Never resolve a failure with an empty error: that's the one thing the
        // heal loop cannot work with.
        error: passed ? "" : (summarizeFailures(json) || describeSilentFailure(stats)).slice(-4000),
        traceUrl,
      });
    });
  });
}

module.exports = { runSpec };
