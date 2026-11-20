const PrReview = require("../model/PrReviewModel");
const ApiSuite = require("../model/ApiSuiteModel");
const ApiWatcher = require("../model/ApiWatcherModel");
const Doc = require("../model/DocModel");
const { ownerFieldsFor, sectionForDoc, suggestMoreCases } = require("./apiSuiteService");

// A validated PR review becomes regression coverage: the tests it proved
// against the real API go into each endpoint's regression suite, and an agent
// adds the cases the review didn't cover. From then on they run like any other
// saved test, on the repo's QA config.

const MAX_ENDPOINTS = 8;
const CREDENTIAL_HEADER = /auth|token|key|secret|cookie|session|password/i;
// Headers the runner sets itself; copying them would only pin stale values.
const TRANSPORT_HEADER = /^(content-length|host|user-agent|accept-encoding|connection)$/i;

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function endpointParts(key) {
  const m = String(key || "").match(/^([A-Z]+)\s+(\S+)$/i);
  return m ? { method: m[1].toUpperCase(), path: m[2] } : null;
}

/** The request's path (and query) without the review URL's own prefix. */
function relativePath(url, basePath) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  let p = u.pathname;
  const base = String(basePath || "").replace(/\/+$/, "");
  if (base && p.startsWith(base)) p = p.slice(base.length) || "/";
  return p + u.search;
}

function categoryFor(test, expected) {
  if (expected.length && expected.every((s) => s === 401 || s === 403)) return "unauthorized";
  if (expected.length && expected.every((s) => s === 404)) return "not_found";
  if (expected.length && expected.every((s) => s === 400 || s === 422)) return "invalid_input";
  if (test.type === "security") return "security";
  if (test.type === "boundary") return "boundary";
  return "happy_path";
}

/** A test the review proved, ready to run again. Null when it can't be reused. */
function caseFromTest(test, basePath, prNumber) {
  if (!test.passed || test.blocked || test.triage) return null;
  const req = test.request;
  if (!req?.url || !req.method) return null;
  // Evidence bodies are cut for display; a cut body isn't the request that ran.
  if (typeof req.body === "string" && req.body.endsWith("[truncated]")) return null;
  const path = relativePath(req.url, basePath);
  if (!path) return null;

  const expected = (test.expectedStatus || []).length
    ? test.expectedStatus.map(Number)
    : test.response?.status
      ? [Number(test.response.status)]
      : [];
  const category = categoryFor(test, expected);

  let headers = null;
  if (category === "unauthorized") {
    // The review sent it without credentials; the runner strips them on this.
    headers = { Authorization: "" };
  } else {
    const kept = Object.entries(req.headers || {}).filter(
      ([k, v]) => !CREDENTIAL_HEADER.test(k) && !TRANSPORT_HEADER.test(k) && v !== "[redacted]"
    );
    if (kept.length) headers = Object.fromEntries(kept);
  }

  return {
    name: test.name || `${req.method} ${path}`,
    covers: test.covers || "",
    category,
    method: String(req.method).toUpperCase(),
    path,
    headers,
    body: req.body ?? null,
    expectedStatus: expected,
    assertions: test.assertions || [],
    fromPr: prNumber,
    fromReviewTest: test._id,
  };
}

async function findDoc({ companyId, owner, repo, branch, method, path }) {
  const docs = await Doc.find({
    companyId,
    owner,
    repo,
    path,
    method: new RegExp(`^${method}$`, "i"),
  });
  return docs.find((d) => (d.branch || "") === (branch || "")) || docs[0] || null;
}

/**
 * Put a reviewed PR's tests into the regression suites of the endpoints it
 * touched, plus the cases an agent adds. Appends; never replaces what the
 * suites already hold, and a second call doesn't copy the same test twice.
 */
async function createRegressionFromReview({ reviewId, companyId, userId, anthropicClient = null }) {
  const review = await PrReview.findOne({ _id: reviewId, companyId });
  if (!review) throw httpError(404, "Review not found");
  if (review.status !== "done") throw httpError(409, "The review hasn't finished yet");

  let basePath = "";
  if (review.watcherId) {
    const watcher = await ApiWatcher.findById(review.watcherId).select("reviewBaseUrl").lean();
    try {
      basePath = new URL(watcher?.reviewBaseUrl || "").pathname;
    } catch (_) {
      basePath = "";
    }
  }

  const keys = [
    ...new Set([
      ...review.tests.map((t) => t.endpoint),
      ...review.criteria.filter((c) => c.testable !== "manual").flatMap((c) => c.endpoints),
    ]),
  ]
    .filter((k) => endpointParts(k))
    .slice(0, MAX_ENDPOINTS);

  const rows = [];
  for (const key of keys) {
    const { method, path } = endpointParts(key);
    const row = { endpoint: key, suiteId: null, fromReview: 0, generated: 0, error: "" };
    rows.push(row);

    const doc = await findDoc({
      companyId,
      owner: review.owner,
      repo: review.repo,
      branch: review.branch,
      method,
      path,
    });
    if (!doc) {
      row.error = "This endpoint has no docs in Olivia yet, so there's no suite to add it to.";
      continue;
    }

    let suite = await ApiSuite.findOne({ docId: doc._id, kind: "regression", companyId });
    if (!suite) {
      suite = new ApiSuite({
        ...ownerFieldsFor(doc),
        docId: doc._id,
        section: sectionForDoc(doc),
        method: doc.method,
        path: doc.path,
        kind: "regression",
        cases: [],
        userId,
        companyId,
      });
    }

    const already = new Set(suite.cases.map((c) => String(c.fromReviewTest || "")));
    for (const t of review.tests.filter((x) => x.endpoint === key)) {
      if (already.has(String(t._id))) continue;
      const c = caseFromTest(t, basePath, review.prNumber);
      if (!c) continue;
      suite.cases.push(c);
      row.fromReview += 1;
    }

    const criteria = review.criteria
      .filter((c) => c.testable !== "manual" && (!c.endpoints.length || c.endpoints.includes(key)))
      .map((c) => c.text);
    try {
      const more = await suggestMoreCases({
        doc,
        existing: suite.cases,
        criteria,
        companyId,
        anthropicClient,
      });
      for (const c of more) suite.cases.push({ ...c, fromPr: review.prNumber });
      row.generated = more.length;
    } catch (err) {
      row.error = `Couldn't write extra cases: ${err.message}`;
    }

    await suite.save();
    row.suiteId = suite._id;
  }

  review.regression = rows;
  review.regressionAt = new Date();
  await review.save();
  return review;
}

module.exports = { createRegressionFromReview, caseFromTest, relativePath };
