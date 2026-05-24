const mongoose = require("mongoose");

const installationSchema = new mongoose.Schema({
  installationId: { type: Number, required: true, unique: true },
  accountLogin: { type: String, required: true },
  accountType: { type: String, enum: ["User", "Organization"], required: true },
  repos: [
    {
      repoName: String,
      repoFullName: String,
    },
  ],
  installedAt: { type: Date, default: Date.now },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company" },
});

module.exports = mongoose.model("Installation", installationSchema);
