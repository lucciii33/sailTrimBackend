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
 * Start a cloud browser session.
 * `injectRecorder: false` gives a plain driveable browser with no recorder —
 * that's the login-capture flow, where we deliberately do NOT want keystrokes
 * on a password field streaming to ingest.
 * @returns {{ browserbaseSessionId: string, liveViewUrl: string }}
 */
async function startSession({
  startUrl,
  token,
  ingestEndpoint,
  storageStateJson,
  injectRecorder = true,
  timeoutSeconds,
}) {
  const bb = getClient();
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!projectId) throw new Error("BROWSERBASE_PROJECT_ID is not set");

  // The Browserbase project default is 5 minutes, which is fine for a recording
  // but far too short for a human typing credentials through SSO/2FA — the
  // session dies mid-login and the capture comes back empty. Callers that wait
  // on a person pass a longer timeout.
  const session = await bb.sessions.create({
    projectId,
    ...(timeoutSeconds ? { timeout: timeoutSeconds } : {}),
  });
  let browser;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || (await browser.newContext());

    // Order matters: register the recorder + auth-seed init scripts BEFORE any
    // navigation so they run on the customer's first page.
    if (injectRecorder) {
      await context.addInitScript(clientRecorderScript({ token, endpoint: ingestEndpoint }));
    }
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

// Read the live session (cookies + localStorage) out of the cloud browser in
// Playwright's storageState format. This is what turns "the customer logged in
// by hand in the embedded browser" into a reusable session for every later
// recording and run.
//
// MUST be called BEFORE finishSession(): that closes the CDP connection, and
// storageState() is unreadable once the browser handle is gone. Returns "" when
// the handle is already gone (process restarted mid-login, see the `active`
// note at the top of this file) so callers can report a clean failure instead
// of saving nothing silently.
async function captureStorageState(browserbaseSessionId) {
  const handle = active.get(browserbaseSessionId);
  if (handle) {
    try {
      return JSON.stringify(await handle.context.storageState());
    } catch (err) {
      console.error("[bb] storageState from held connection failed:", err.message);
      // fall through — the held connection is stale, but the cloud session
      // itself may still be alive.
    }
  }
  return reconnectAndCapture(browserbaseSessionId);
}

// The held handle is gone (nodemon reloaded the dev server, another instance
// answered the request, the process crashed) — but the browser lives in
// Browserbase, not here. Reconnect to it and read the session anyway. This is
// what keeps a login capture from being lost to an unrelated backend restart,
// and it's what lets this work with more than one backend instance.
async function reconnectAndCapture(browserbaseSessionId) {
  let browser;
  try {
    const session = await getClient().sessions.retrieve(browserbaseSessionId);
    if (!session?.connectUrl) return "";
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    if (!context) return "";
    const json = JSON.stringify(await context.storageState());
    console.log(`[bb] storageState recovered by reconnect for ${browserbaseSessionId}`);
    return json;
  } catch (err) {
    console.error("[bb] storageState reconnect failed:", err.message);
    return "";
  } finally {
    if (browser) await browser.close().catch(() => {});
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

module.exports = { startSession, captureStorageState, finishSession };
