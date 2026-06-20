const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Runs ONE generated spec with Playwright and reports whether it passed plus the
// failure output (fed back to Claude in the heal loop). Same cwd convention as
// the recorder: E2E_RECORDER_CWD or the sibling oliviatools repo, which has
// @playwright/test + playwright.config installed. The app under test is reached
// via E2E_BASE_URL (we set it from the project's baseUrl).
//
// This is the local-dev runner: the browser/test process runs on the backend
// host. (Productized: run in an isolated container / CI.)
function resolveCwd() {
  return (
    process.env.E2E_RECORDER_CWD ||
    path.resolve(__dirname, "../../../oliviatools")
  );
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
    const cwd = resolveCwd();
    const dir = path.join(cwd, "tests", "e2e");
    let file;
    try {
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `_heal-${crypto.randomUUID()}.spec.ts`);
      fs.writeFileSync(file, injectStorageState(specCode, storagePath), "utf8");
    } catch (e) {
      return resolve({ passed: false, error: `Could not write spec: ${e.message}` });
    }

    const cleanup = () => fs.promises.unlink(file).catch(() => {});
    const env = { ...process.env };
    if (baseUrl) env.E2E_BASE_URL = baseUrl;

    // --reporter=json prints the report to stdout (overrides the config reporters
    // so we don't fight over test-results/results.json across concurrent runs).
    const cp = spawn(
      "npx",
      ["playwright", "test", file, "--reporter=json", "--workers=1"],
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
        error: `Could not launch Playwright (is it installed in ${cwd}?): ${e.message}`,
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
