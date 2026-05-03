const mongoose = require("mongoose");

const companyInviteSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    email: { type: String, required: true, lowercase: true, index: true },
    token: { type: String, required: true, unique: true, index: true },
    role: { type: String, enum: ["member", "owner"], default: "member" },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

companyInviteSchema.index({ companyId: 1, email: 1 });

module.exports = mongoose.model("CompanyInvite", companyInviteSchema);
