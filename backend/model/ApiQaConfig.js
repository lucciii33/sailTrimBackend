const mongoose = require("mongoose");

const authSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["none", "apiKey", "bearer", "basic", "custom"],
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
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

apiQaConfigSchema.index(
  { companyId: 1, owner: 1, repo: 1 },
  { unique: true }
);

module.exports = mongoose.model("ApiQaConfig", apiQaConfigSchema);
