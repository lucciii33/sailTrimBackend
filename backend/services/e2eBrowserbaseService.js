// Cloud-browser recorder backend. Olivia spins up a Browserbase session, drives
// it with Playwright over CDP to (a) inject the recorder and (b) seed the
// customer's logged-in session, then hands the live-view URL to the frontend so
// the customer can drive that same browser from an embedded iframe — no
// install, no changes to their app. Verified feasible end to end (session +
// CDP + addInitScript + capture across navigations) before this was written.
//
// The Playwright connection is kept OPEN for the whole recording (held in
// `active` below) because addInitScript stays in effect only while the CDP
// client is connected. finishSession() closes it. NOTE: `active` is in-process
// memory — recording assumes a single backend instance for the session's life
// (fine today; if this scales horizontally, move the handle to a shared store
// or sticky routing).
const { Browserbase } = require("@browserbasehq/sdk");
const { chromium } = require("playwright-core");
const { clientRecorderScript } = require("./e2eClientRecorderScript");

const active = new Map(); // browserbaseSessionId -> { browser, context }

function getClient() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY is not set");
  return new Browserbase({ apiKey });
}

// storageState JSON (Playwright format) -> cookies loaded into the context and
// localStorage seeded per-origin via an init script (localStorage can't be set
// through addCookies, so we replay it on document creation for its origin).
async function applyStorageState(context, storageStateJson) {
  if (!storageStateJson) return;
  let state;
  try {
    state = typeof storageStateJson === "string" ? JSON.parse(storageStateJson) : storageStateJson;
  } catch (_) {
    return;
  }
  if (Array.isArray(state.cookies) && state.cookies.length) {
    try {
      await context.addCookies(state.cookies);
    } catch (err) {
      console.error("[bb] addCookies failed:", err.message);
    }
  }
  for (const origin of state.origins || []) {
    const items = origin.localStorage || [];
    if (!items.length) continue;
    const seed = JSON.stringify(items);
    await context.addInitScript(
      ({ originUrl, entries }) => {
        try {
          if (location.origin !== originUrl) return;
          for (const { name, value } of entries) localStorage.setItem(name, value);
        } catch (e) {}
      },
      { originUrl: origin.origin, entries: JSON.parse(seed) }
    );
  }
}

/**
 * Start a cloud recording session.
 * @returns {{ browserbaseSessionId: string, liveViewUrl: string }}
 */
async function startSession({ startUrl, token, ingestEndpoint, storageStateJson }) {
  const bb = getClient();
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!projectId) throw new Error("BROWSERBASE_PROJECT_ID is not set");

  const session = await bb.sessions.create({ projectId });
  let browser;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || (await browser.newContext());

    // Order matters: register the recorder + auth-seed init scripts BEFORE any
    // navigation so they run on the customer's first page.
    await context.addInitScript(clientRecorderScript({ token, endpoint: ingestEndpoint }));
    await applyStorageState(context, storageStateJson);

    const page = context.pages()[0] || (await context.newPage());
    if (startUrl) {
      await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch((e) => {
        console.error("[bb] initial goto failed:", e.message);
      });
    }

    const live = await bb.sessions.debug(session.id);
    const liveViewUrl = live.debuggerFullscreenUrl || live.debuggerUrl || "";

    active.set(session.id, { browser, context });
    return { browserbaseSessionId: session.id, liveViewUrl };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    await releaseSession(bb, session.id);
    throw err;
  }
}

async function releaseSession(bb, sessionId) {
  try {
    await bb.sessions.update(sessionId, {
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      status: "REQUEST_RELEASE",
    });
  } catch (_) {
    /* session may already be gone */
  }
}

// Close the held Playwright connection and release the Browserbase session.
async function finishSession(browserbaseSessionId) {
  const handle = active.get(browserbaseSessionId);
  if (handle) {
    await handle.browser.close().catch(() => {});
    active.delete(browserbaseSessionId);
  }
  if (browserbaseSessionId) {
    await releaseSession(getClient(), browserbaseSessionId).catch(() => {});
  }
}

module.exports = { startSession, finishSession };
