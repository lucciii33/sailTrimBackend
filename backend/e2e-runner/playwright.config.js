const { defineConfig, devices } = require("@playwright/test");
const path = require("path");

// Playwright config OWNED BY THE BACKEND, used by the self-heal loop to execute
// a generated spec and report pass/fail.
//
// This exists because the loop used to borrow the frontend repo's config
// (oliviatools/playwright.config.ts), which brought two things that are wrong
// here:
//   1. `webServer: npm run dev` — that boots OliviaTools' own dev server on
//      localhost:5173 before every run, even when the app under test is a
//      customer's deployed site. Irrelevant work at best; on a deployed backend
//      the frontend repo isn't even on disk.
//   2. it only existed on a developer's laptop next to the backend checkout.
//
// The app under test is always already running (it's the customer's), so there
// is deliberately NO webServer here.
module.exports = defineConfig({
  testDir: process.env.E2E_SPEC_DIR || path.join(__dirname, "specs"),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // One spec per run, driven by e2ePlaywrightRunner — parallelism would only
  // multiply browsers for a single user's heal attempt.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["json"]],
  // Written next to the specs, read by the runner and deleted after each attempt
  // (the trace is uploaded to S3 first — this host's disk is ephemeral).
  outputDir: path.join(__dirname, "artifacts"),
  use: {
    baseURL: process.env.E2E_BASE_URL,
    // PAUSED. Traces are a DOM snapshot of the customer's app in a LOGGED-IN
    // session — real data, and whatever tokens the network log captured — and
    // they were being uploaded to a publicly-readable S3 bucket. Turned off
    // until that's behind signed, expiring URLs.
    // To re-enable, swap the two lines below back and uncomment the upload in
    // e2ePlaywrightRunner.js (search: PAUSED).
    // trace: "retain-on-failure",
    // screenshot: "only-on-failure",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
