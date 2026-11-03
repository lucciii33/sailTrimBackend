// One customer, one copy of Olivia: its own server, database, bucket and
// secrets, reached at its own subdomain (acme.oliviatools.com). The code is the
// same as the shared service; OLIVIA_DEDICATED=true switches off what only makes
// sense there, such as public sign-up and the open CORS policy.

// A copy started without one of these would quietly fall back to a default or
// fail on the first customer request. Better that the deploy fails.
const REQUIRED_ENV = [
  "MONGO_URL",
  "JWT_SECRET_NODE",
  "QA_ENC_KEY",
  "FRONTEND_URL",
  "AWS_BUCKET_NAME",
  "OLIVIA_INSTANCE_KEY",
  "OLIVIA_HUB_URL",
  "GITHUB_WEBHOOK_SECRET",
];

function isDedicated() {
  return process.env.OLIVIA_DEDICATED === "true";
}

function assertDedicatedConfig() {
  if (!isDedicated()) return;
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(
      `Dedicated instance is missing required settings: ${missing.join(", ")}`
    );
  }
}

// The instance's own frontend plus any extras, comma-separated.
function allowedOrigins() {
  return [process.env.FRONTEND_URL, process.env.ALLOWED_ORIGINS]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

// Options for the cors middleware. The shared service stays open, as it was.
// Requests with no Origin (GitHub webhooks, curl) are not browser requests, so
// CORS has nothing to say about them.
function corsOptions() {
  if (!isDedicated()) return {};
  const allowed = allowedOrigins();
  return {
    origin(origin, callback) {
      callback(null, !origin || allowed.includes(origin));
    },
  };
}

module.exports = {
  REQUIRED_ENV,
  isDedicated,
  assertDedicatedConfig,
  allowedOrigins,
  corsOptions,
};
