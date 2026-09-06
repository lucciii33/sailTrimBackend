const mongoose = require("mongoose");

// Same shape as ApiQaConfig.auth so the QA runner can reuse buildAuthHeaders.
const authSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      // oauth2_client_credentials is resolved at run time by
      // resolveRuntimeAuth (it fetches a token from token_url using the
      // client_id/client_secret variables). It was missing here, so picking it
      // in the UI failed schema validation on save and only worked by
      // accident, via the auto-detect path.
      enum: [
        "none",
        "apiKey",
        "bearer",
        "basic",
        "custom",
        "oauth2_client_credentials",
      ],
      default: "none",
    },
    headerName: { type: String, default: "" },
    valueEncrypted: { type: String, default: "" },
    username: { type: String, default: "" },
    passwordEncrypted: { type: String, default: "" },
  },
  { _id: false },
);

// Environment variable: used to fill {{key}} / path params ({key}) in requests
// at run time — e.g. baseUrl overrides, a real userId, a test providerId.
// Secret values are encrypted at rest (like a token); plain ones are visible.
const variableSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    value: { type: String, default: "" }, // encrypted when secret=true
    secret: { type: Boolean, default: false },
  },
  { _id: false },
);

// Optional link to a GitHub repo, so a manually-pasted spec can later be
// "connected" and re-synced from source without re-keying everything.
const githubSchema = new mongoose.Schema(
  {
    owner: { type: String, default: "" },
    repo: { type: String, default: "" },
    specPath: { type: String, default: "" },
    // GitHub App installation that can read the repo — stored so the manual
    // "Sync" button can re-fetch the spec without re-picking the install.
    installationId: { type: Number },
    defaultBranch: { type: String, default: "" },
    lastSyncedAt: { type: Date },
  },
  { _id: false },
);

// An imported API spec lives as its own project — decoupled from any GitHub
// owner/repo. Endpoints (Docs) reference it by projectId.
const apiProjectSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    index: true,
  },
  name: { type: String, required: true }, // slug used for de-dup on re-import
  title: { type: String, default: "" }, // human title from spec info.title
  version: { type: String, default: "" },
  source: { type: String, enum: ["manual", "github"], default: "manual" },
  baseUrl: { type: String, default: "" },
  auth: { type: authSchema, default: () => ({ type: "none" }) },
  variables: { type: [variableSchema], default: [] },
  github: { type: githubSchema, default: () => ({}) },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

apiProjectSchema.index({ companyId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("ApiProject", apiProjectSchema);
