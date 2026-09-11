const mongoose = require("mongoose");

const paramSchema = new mongoose.Schema(
  {
    name: String,
    type: String,
    required: Boolean,
    description: String,
  },
  { _id: false }
);

const responseSchema = new mongoose.Schema(
  {
    status: Number,
    description: String,
    example: mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const docSchema = new mongoose.Schema({
  method: { type: String, required: true },
  path: { type: String, required: true },
  section: { type: String, default: "default" },
  // Per-endpoint overrides for {{key}} / {id} substitution. The global set
  // (ApiQaConfig.variables for a repo, ApiProject.variables for a spec) applies
  // to every endpoint; these win for THIS one — so a test that needs its own
  // id, or a token with different scope, doesn't force you to change the value
  // every other endpoint depends on. Secrets are encrypted at rest, same rule
  // as the global ones.
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
  description: { type: String, required: true },
  requestBody: [paramSchema],
  queryParams: [paramSchema],
  responses: [responseSchema],
  // Optional user-provided body the QA generator uses as the base for the
  // happy_path case. When empty, the model builds the body from requestBody +
  // discovery data as before.
  exampleBody: { type: mongoose.Schema.Types.Mixed },
  prNumber: { type: Number },
  // Spec-import endpoints belong to an ApiProject instead of a GitHub repo.
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ApiProject",
    index: true,
  },
  // owner/repo are only required for the GitHub-docs flow; spec imports leave
  // them empty and key off projectId.
  repo: { type: String },
  owner: { type: String },
  source: { type: String, enum: ["pr", "backfill"], default: "pr" },
  sourceFile: { type: String },
  sourceSha: { type: String },
  // False when the route file that defines this endpoint exists in the repo
  // but nothing ever mounts it (dead/unreachable code) — see
  // isOrphanRouteFile in services/githubService.js.
  mounted: { type: Boolean, default: true },
  // Flagged by the watcher when an endpoint appears that wasn't in the previous
  // scan of the repo. Cleared once someone has looked at it, so "what shipped
  // since I last checked" stays answerable.
  //
  // NOT called `isNew`: mongoose reserves that name for its own "this document
  // has not been saved yet" flag, and shadowing it breaks saves in ways that
  // only show up later.
  isNewEndpoint: { type: Boolean, default: false, index: true },
  firstSeenAt: { type: Date, default: null },
  // The PR that introduced it, so the endpoint links back to the change.
  firstSeenPr: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
});

docSchema.index({ companyId: 1, owner: 1, repo: 1 });

module.exports = mongoose.model("Doc", docSchema);
