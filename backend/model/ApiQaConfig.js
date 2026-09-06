const mongoose = require("mongoose");

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
  { _id: false }
);

const apiQaConfigSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    index: true,
  },
  owner: { type: String, required: true },
  repo: { type: String, required: true },
  baseUrl: { type: String, required: true },
  auth: { type: authSchema, default: () => ({ type: "none" }) },
  defaultHeaders: { type: Map, of: String, default: {} },
  // Path/template variables: fill {id} / :id in the route and {{key}} tokens.
  // `secret` marks a value that is encrypted at rest (tokens, api keys) —
  // buildVarMap decrypts those at run time. It used to be missing here, so a
  // token typed into a repo's variables was stored in plaintext while the very
  // same field on an ApiProject was encrypted. Existing rows have secret unset
  // and stay readable as plaintext, so this is backward compatible.
  variables: {
    type: [
      new mongoose.Schema(
        {
          key: { type: String, required: true },
          value: { type: String, default: "" },
          secret: { type: Boolean, default: false },
        },
        { _id: false }
      ),
    ],
    default: [],
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

apiQaConfigSchema.index(
  { companyId: 1, owner: 1, repo: 1 },
  { unique: true }
);

module.exports = mongoose.model("ApiQaConfig", apiQaConfigSchema);
