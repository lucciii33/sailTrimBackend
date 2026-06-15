const mongoose = require("mongoose");

// Browser login for the app under test. The Playwright runner (Feature 2) uses
// this to reach authenticated flows. Password is encrypted at rest like any
// other secret (see secretCrypto). All selectors default to data-testid based
// hints so the standard is enforced from the login screen onward.
const loginSchema = new mongoose.Schema(
  {
    url: { type: String, default: "" },
    username: { type: String, default: "" },
    passwordEncrypted: { type: String, default: "" },
    usernameSelector: { type: String, default: "" },
    passwordSelector: { type: String, default: "" },
    submitSelector: { type: String, default: "" },
    // Captured ONCE: the authenticated Playwright session (cookies/localStorage).
    // Every test recording + run loads this so it starts already logged in —
    // the login flow never gets re-recorded per test.
    storageStatePath: { type: String, default: "" },
    authSavedAt: { type: Date, default: null },
  },
  { _id: false },
);

// Where the generated specs get committed. owner/repo identify the front-end
// repo (oliviatools); branch is the SINGLE branch the user picks once — every
// test lands as its own commit on this same branch.
const githubSchema = new mongoose.Schema(
  {
    owner: { type: String, default: "" },
    repo: { type: String, default: "" },
    branch: { type: String, default: "" },
    testDir: { type: String, default: "tests/e2e" }, // where specs are written
  },
  { _id: false },
);

// Reusable test data the generator/runner can inject (e.g. a known account,
// a search term). Mirrors ApiProject.variables. Secrets encrypted at rest.
const variableSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    value: { type: String, default: "" },
    secret: { type: Boolean, default: false },
  },
  { _id: false },
);

const e2eProjectSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    index: true,
  },
  name: { type: String, required: true }, // slug used for de-dup per company
  title: { type: String, default: "" },
  baseUrl: { type: String, default: "" }, // deployed app under test
  login: { type: loginSchema, default: () => ({}) },
  github: { type: githubSchema, default: () => ({}) },
  variables: { type: [variableSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

e2eProjectSchema.index({ companyId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("E2eProject", e2eProjectSchema);
