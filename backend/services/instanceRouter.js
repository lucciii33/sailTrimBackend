const InstanceRoute = require("../model/InstanceRouteModel");

// Every instance shares one GitHub App, and a GitHub App has one webhook URL and
// one callback URL. Both point at the main backend, which passes each event and
// each browser redirect on to the instance it belongs to.
//
// Main backend: OLIVIA_INSTANCES={"acme":"https://api.acme.oliviatools.com"}
// Instance:     OLIVIA_INSTANCE_KEY=acme
//
// The instance puts its key in front of the OAuth state ("acme~<jwt>") because
// the state is the only thing that comes back through GitHub untouched.
const STATE_SEPARATOR = "~";
const FORWARD_TIMEOUT_MS = 9000;

function registry() {
  try {
    return JSON.parse(process.env.OLIVIA_INSTANCES || "{}");
  } catch (err) {
    console.error("[instances] OLIVIA_INSTANCES is not valid JSON");
    return {};
  }
}

function instanceUrl(key) {
  if (!Object.prototype.hasOwnProperty.call(registry(), key)) return null;
  return String(registry()[key]).replace(/\/+$/, "");
}

/** The state to send to GitHub: tagged with this instance, if it is one. */
function wrapState(state) {
  const key = process.env.OLIVIA_INSTANCE_KEY;
  return key ? `${key}${STATE_SEPARATOR}${state}` : state;
}

/** The signed token inside a state, without this instance's tag. */
function unwrapState(rawState) {
  const key = process.env.OLIVIA_INSTANCE_KEY;
  const prefix = `${key}${STATE_SEPARATOR}`;
  return key && rawState?.startsWith(prefix) ? rawState.slice(prefix.length) : rawState;
}

async function saveRoute(kind, value, instance) {
  await InstanceRoute.updateOne(
    { kind, value: String(value) },
    { $set: { instance } },
    { upsert: true }
  );
}

/**
 * Main backend, /callback: where to send this browser if the connection was
 * started on an instance, or null if it is ours to handle.
 */
async function callbackTarget(query) {
  const rawState = typeof query.state === "string" ? query.state : "";
  const key = rawState.split(STATE_SEPARATOR)[0];
  const url = rawState.includes(STATE_SEPARATOR) ? instanceUrl(key) : null;
  if (!url) return null;
  if (query.installation_id) {
    await saveRoute("installation", query.installation_id, key);
  }
  return `${url}/api/github/callback?${new URLSearchParams(query)}`;
}

/**
 * Main backend, /webhook: the instance that should ALSO get this event, or
 * null. Only installations someone connected from that instance (recorded by
 * callbackTarget) are copied to it. The main backend handles every event
 * itself either way: an instance gets a copy, never the event instead of us.
 */
async function webhookTarget(event, payload) {
  if (!Object.keys(registry()).length) return null;
  const installationId = payload.installation?.id;
  if (!installationId) return null;
  const known = await InstanceRoute.findOne({
    kind: "installation",
    value: String(installationId),
  }).lean();
  return known && instanceUrl(known.instance) ? known.instance : null;
}

/** Pass an event on untouched, so the instance can check GitHub's signature. */
async function forwardWebhook(key, body, headers) {
  const res = await fetch(`${instanceUrl(key)}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": headers["x-github-event"],
      "x-github-delivery": headers["x-github-delivery"] || "",
      "x-hub-signature-256": headers["x-hub-signature-256"],
    },
    body,
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
  return res.ok;
}

module.exports = {
  wrapState,
  unwrapState,
  callbackTarget,
  webhookTarget,
  forwardWebhook,
};
