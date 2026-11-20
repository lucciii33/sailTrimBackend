const { decrypt } = require("./secretCrypto");

// What a generated test needs AROUND it to run in the customer's own repo.
//
// Olivia executes specs with its own config, its own baseURL and a session it
// captured — so a spec that is green here lands in the customer's repo and fails
// on `npx playwright test`, because none of that exists there. That failure
// reads as "Olivia writes broken tests", which is the opposite of the product.
//
// So the pull request carries the kit too: a config, a login step that uses
// THEIR secrets, a npm script, and a workflow so it runs on every PR. Nothing is
// overwritten — a repo that already has Playwright keeps its own setup, and only
// the missing pieces are added.
//
// Secrets are never committed. The login step reads E2E_USER / E2E_PASSWORD from
// the environment, and the PR says which secrets to set.

const AUTH_STATE = "playwright/.auth/user.json";

function configFile({ testDir }) {
  return `import { defineConfig, devices } from "@playwright/test";

// Added by Olivia. The app under test is already running (your deployed
// environment or a local dev server), so there is deliberately no \`webServer\`.
//
// E2E_BASE_URL is the environment the tests run against. Set it in CI and
// locally; nothing here is specific to one machine.
export default defineConfig({
  testDir: "${testDir}",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Logs in once and saves the session; every other project reuses it, so no
    // test re-does the login.
    { name: "setup", testMatch: /auth\\.setup\\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "${AUTH_STATE}" },
      dependencies: ["setup"],
    },
  ],
});
`;
}

// The login as a setup project, built from what the customer already configured
// in Olivia (the login URL and the three selectors) — not guessed.
function authSetupFile({ login }) {
  const url = login?.url || "/login";
  const userSel = login?.usernameSelector || '[data-testid="email"]';
  const passSel = login?.passwordSelector || '[data-testid="password"]';
  const submitSel = login?.submitSelector || '[data-testid="submit"]';

  return `import { test as setup, expect } from "@playwright/test";

// Added by Olivia. Logs in once and stores the session for the other projects.
//
// Credentials come from the environment — never committed. Set E2E_USER and
// E2E_PASSWORD locally and as repository secrets in CI.
const AUTH_FILE = "${AUTH_STATE}";

setup("authenticate", async ({ page }) => {
  const user = process.env.E2E_USER;
  const password = process.env.E2E_PASSWORD;
  if (!user || !password) {
    throw new Error(
      "E2E_USER and E2E_PASSWORD must be set — the suite signs in before running."
    );
  }

  await page.goto("${url}");
  await page.locator('${userSel}').fill(user);
  await page.locator('${passSel}').fill(password);
  await page.locator('${submitSel}').click();

  // Logged in when the login form is gone. If this times out, the credentials
  // or the selectors changed — fix them here, not in every test.
  await expect(page.locator('${submitSel}')).toHaveCount(0, { timeout: 15_000 });

  await page.context().storageState({ path: AUTH_FILE });
});
`;
}

function workflowFile({ testDir }) {
  return `# Added by Olivia. Runs the end-to-end tests on every pull request.
#
# Needs three repository secrets:
#   E2E_BASE_URL  the environment to test (e.g. https://staging.example.com)
#   E2E_USER      the account the tests sign in as
#   E2E_PASSWORD  its password
#
# Use a dedicated test account, not a real user's.
name: E2E (Olivia)

on:
  pull_request:
  workflow_dispatch:

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test ${testDir}
        env:
          E2E_BASE_URL: \${{ secrets.E2E_BASE_URL }}
          E2E_USER: \${{ secrets.E2E_USER }}
          E2E_PASSWORD: \${{ secrets.E2E_PASSWORD }}
      - uses: actions/upload-artifact@v4
        if: \${{ !cancelled() }}
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
`;
}

async function readFile(octokit, { owner, repo, branch, path }) {
  try {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner, repo, path, ref: branch }
    );
    if (Array.isArray(data)) return null;
    return {
      sha: data.sha,
      content: Buffer.from(data.content || "", "base64").toString("utf8"),
    };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function exists(octokit, args) {
  return Boolean(await readFile(octokit, args));
}

/**
 * The files this repo is missing for a generated spec to run, as
 * [{ path, content, message }]. Empty when the repo is already set up.
 */
async function missingKitFiles(octokit, { owner, repo, branch, project }) {
  const testDir = (project.github?.testDir || "tests/e2e").replace(/\/+$/, "");
  const files = [];

  // A repo with its own Playwright config keeps it: ours would fight theirs.
  const hasConfig = (
    await Promise.all(
      [
        "playwright.config.ts",
        "playwright.config.js",
        "playwright.config.mjs",
        "playwright.config.cjs",
      ].map((path) => exists(octokit, { owner, repo, branch, path }))
    )
  ).some(Boolean);

  if (!hasConfig) {
    files.push({
      path: "playwright.config.ts",
      content: configFile({ testDir }),
      message: "chore(e2e): add Playwright config (Olivia)",
    });
  }

  const authPath = "playwright/auth.setup.ts";
  if (!hasConfig && !(await exists(octokit, { owner, repo, branch, path: authPath }))) {
    const login = project.login || {};
    files.push({
      path: authPath,
      content: authSetupFile({ login }),
      message: "chore(e2e): add login setup (Olivia)",
    });
  }

  const workflowPath = ".github/workflows/olivia-e2e.yml";
  if (!(await exists(octokit, { owner, repo, branch, path: workflowPath }))) {
    files.push({
      path: workflowPath,
      content: workflowFile({ testDir }),
      message: "ci(e2e): run the end-to-end tests on every PR (Olivia)",
    });
  }

  // The saved session is a live credential — it must never be committed.
  const gitignore = await readFile(octokit, { owner, repo, branch, path: ".gitignore" });
  if (gitignore && !gitignore.content.includes("playwright/.auth")) {
    files.push({
      path: ".gitignore",
      content: `${gitignore.content.replace(/\s*$/, "")}\n\n# Playwright session saved by the e2e login step (Olivia)\nplaywright/.auth/\nplaywright-report/\ntest-results/\n`,
      message: "chore(e2e): keep the saved session out of git (Olivia)",
    });
  }

  // A script, and the dependency, so `npm run test:e2e` works for everyone.
  const pkg = await readFile(octokit, { owner, repo, branch, path: "package.json" });
  if (pkg) {
    try {
      const json = JSON.parse(pkg.content);
      let changed = false;
      json.scripts = json.scripts || {};
      if (!json.scripts["test:e2e"]) {
        json.scripts["test:e2e"] = "playwright test";
        changed = true;
      }
      const hasPw =
        json.devDependencies?.["@playwright/test"] ||
        json.dependencies?.["@playwright/test"];
      if (!hasPw) {
        json.devDependencies = json.devDependencies || {};
        json.devDependencies["@playwright/test"] = "^1.49.0";
        changed = true;
      }
      if (changed) {
        files.push({
          path: "package.json",
          content: `${JSON.stringify(json, null, 2)}\n`,
          message: "chore(e2e): add the Playwright dependency and script (Olivia)",
        });
      }
    } catch (_) {
      // A package.json we can't parse is one we must not rewrite.
    }
  }

  return files;
}

/** The lines the pull request needs so a human knows what to do next. */
function kitNotes(files) {
  if (!files.length) return "";
  const added = files.map((f) => `- \`${f.path}\``).join("\n");
  const needsSecrets = files.some((f) => f.path.includes("workflows"));
  return [
    "",
    "### Setup added with these tests",
    added,
    "",
    ...(needsSecrets
      ? [
          "The workflow needs three repository secrets before it can run:",
          "`E2E_BASE_URL` (the environment to test), `E2E_USER` and `E2E_PASSWORD`",
          "(a dedicated test account — not a real user's).",
          "",
        ]
      : []),
    "Locally: `npm install && npx playwright install chromium && npm run test:e2e`.",
  ].join("\n");
}

module.exports = { missingKitFiles, kitNotes, decryptLoginPassword: decrypt };
