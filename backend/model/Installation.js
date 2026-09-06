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
  // GitHub ids of people whose install request was APPROVED but who we could
  // not link to an Olivia account at the time — almost always because they had
  // never signed in through GitHub, so we had no id of theirs to match against.
  //
  // Without this the approval was simply lost: the repo was live on GitHub and
  // invisible in Olivia, with no way back except an admin re-connecting. Keeping
  // the requester here lets us link them retroactively the moment they do
  // connect their GitHub (see reconcileInstallationsForGithubUser). It's an
  // array because several people can request before any of them signs in.
  pendingRequesterIds: { type: [String], default: [], index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company" },
});

module.exports = mongoose.model("Installation", installationSchema);
