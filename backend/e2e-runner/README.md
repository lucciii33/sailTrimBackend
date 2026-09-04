# e2e-runner

Where the self-heal loop ("Improve") executes generated Playwright specs.

`services/e2ePlaywrightRunner.js` writes one spec into `specs/`, runs it with
`playwright.config.js` here, reads the JSON report, and deletes the spec. The
loop feeds any failure back to Claude and retries (max 4, `E2E_HEAL_MAX_ATTEMPTS`).

## Why the browser is local and not Browserbase

Browserbase is for flows a **human** drives — the login capture and the flow
recorder — because the customer has to see and click in the browser. The heal
loop has no human: it executes a spec and reads pass/fail.

Sending it to Browserbase would spend one cloud session per attempt, against a
plan that allows **3 concurrent sessions and 5 creations per minute**. A single
user running Improve (up to 4 attempts) would starve everyone else. Headless
Chromium on this host has no such ceiling and no per-session cost.

## Deploy requirement

The browser binary is NOT installed by `npm install`. The build step must run:

    npm install && npx playwright install chromium

Without it, Improve fails with a message saying exactly this. Login and cloud
recording are unaffected — those use Browserbase and need no local browser.

If the platform's image is missing Chromium's shared libraries, either add
`--with-deps` (needs root) or deploy from a container based on
`mcr.microsoft.com/playwright`.

## Notes

- `specs/` is generated at runtime: gitignored, and in nodemon's ignore list so
  writing a spec can't restart the dev server mid-loop.
- There is deliberately **no** `webServer` in the config — the app under test is
  the customer's and is already running. The old setup borrowed the frontend
  repo's config, which booted OliviaTools' vite server before every run.
- `E2E_RECORDER_CWD` no longer affects this runner. It still points the *local*
  codegen recorder (`e2eRecorderService`) at a repo with Playwright installed.
