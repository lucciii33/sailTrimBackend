const mongoose = require("mongoose");

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    plan: { type: String, enum: ["free", "pro"], default: "free" },
    slackChannelId: { type: String },
    slackBotTokenEncrypted: { type: String },
    slackBotTokenMask: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Company", companySchema);
