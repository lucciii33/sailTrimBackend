const mongoose = require("mongoose");

const userSchema = mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
    },
    lastName: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    password: {
      // Not required: SSO (Google) users authenticate via their IdP and have
      // no local password. Email/password users still always set this.
      type: String,
      required: false,
    },
    googleId: {
      type: String,
      required: false,
      index: true,
    },
    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },
    edad: {
      type: Number,
      required: false,
    },
    pais: {
      type: String,
      required: false,
    },
    customerId: {
      type: String,
      required: false,
    },
    customerIdStripe: {
      type: String,
      required: false,
    },
    terms: {
      type: Boolean,
      required: false,
    },
    resetPasswordToken: {
      type: String,
      required: false,
    },
    resetPasswordExpire: {
      type: Date,
      required: false,
    },
    lastReset: {
      type: Date, // Este es el campo que necesitas para guardar la fecha de reinicio
    },
    hasTrial: {
      type: Boolean,
      default: false,
    },
    secretKeyStripe: {
      type: String,
      required: false,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      index: true,
    },
    role: {
      type: String,
      enum: ["owner", "member"],
      default: "owner",
    },
    anthropicKeyEncrypted: {
      type: String,
      required: false,
    },
    anthropicKeyMask: {
      type: String,
      required: false,
    },
    passwordHistory: {
      type: [
        {
          hash: { type: String, required: true },
          changedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      select: false,
    },
    passwordChangedAt: {
      type: Date,
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
    },
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    twoFactorSecret: {
      type: String,
      select: false,
    },
    twoFactorBackupCodes: {
      type: [String],
      default: [],
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("User", userSchema);
