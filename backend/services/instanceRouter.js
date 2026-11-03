const crypto = require("crypto");
const InstanceRoute = require("../model/InstanceRouteModel");

// Every instance shares one GitHub App, and a GitHub App has one webhook URL and
// one callback URL. Both point at the main backend, which passes each event and
// each browser redirect on to the instance it belongs to.
//
// Main backend: OLIVIA_INSTANCES={"acme":"https://api.acme.oliviatools.com"}
// Instance:     OLIVIA_INSTANCE_KEY=acme, OLIVIA_HUB_URL=<main backend>
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

/** Main backend, /webhook: the instance this event belongs to, or null. */
async function webhookTarget(event, payload) {
  if (!Object.keys(registry()).length) return null;
  const installationId = payload.installation?.id;
  if (!installationId) return null;

  const known = await InstanceRoute.findOne({
    kind: "installation",
    value: String(installationId),
  }).lean();
  if (known) return instanceUrl(known.instance) ? known.instance : null;

  // Only a brand-new installation is matched by person. Anyone can open a pull
  // request on a repo that isn't connected to their instance.
  if (event !== "installation" || payload.action !== "created") return null;

  const githubUserId = payload.requester?.id || payload.sender?.id;
  if (!githubUserId) return null;
  const person = await InstanceRoute.findOne({
    kind: "github-user",
    value: String(githubUserId),
  }).lean();
  if (!person || !instanceUrl(person.instance)) return null;

  await saveRoute("installation", installationId, person.instance);
  return person.instance;
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

/** Main backend: someone connecting from an instance, reported by reportIdentity. */
async function saveIdentity(instance, githubUserId) {
  if (!instanceUrl(instance) || !githubUserId) return false;
  await saveRoute("github-user", githubUserId, instance);
  return true;
}

/** Main backend: this person now connects here, not from an instance. */
async function clearIdentity(githubUserId) {
  await InstanceRoute.deleteOne({ kind: "github-user", value: String(githubUserId) });
}

/** Instance: tell the main backend whose GitHub events are coming our way. */
async function reportIdentity(githubUserId) {
  const hub = process.env.OLIVIA_HUB_URL;
  const instance = process.env.OLIVIA_INSTANCE_KEY;
  if (!hub || !instance) return;
  const body = JSON.stringify({ instance, githubUserId: String(githubUserId) });
  const digest = crypto
    .createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  const res = await fetch(`${hub.replace(/\/+$/, "")}/webhook/identity`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${digest}`,
    },
    body,
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`main backend answered ${res.status}`);
}

module.exports = {
  wrapState,
  unwrapState,
  callbackTarget,
  webhookTarget,
  forwardWebhook,
  saveIdentity,
  clearIdentity,
  reportIdentity,
};
