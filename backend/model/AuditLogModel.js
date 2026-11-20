const mongoose = require("mongoose");

const AUDIT_EVENTS = [
  "user_register",
  "user_login_success",
  "user_login_failed",
  "user_login_locked",
  "user_logout",
  "password_reset_requested",
  "password_reset_completed",
  "password_changed",
  "two_factor_setup_started",
  "two_factor_enabled",
  "two_factor_disabled",
  "two_factor_verify_success",
  "two_factor_verify_failed",
  "member_invited",
  "member_invite_accepted",
  "member_invite_cancelled",
  "member_removed",
  "anthropic_key_saved",
  "anthropic_key_removed",
  "slack_config_saved",
  "slack_config_removed",
];

const auditLogSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, enum: AUDIT_EVENTS, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      index: true,
    },
    actorEmail: { type: String },
    ip: { type: String },
    userAgent: { type: String },
    targetType: { type: String },
    targetId: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
    success: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ companyId: 1, createdAt: -1 });
auditLogSchema.index({ userId: 1, createdAt: -1 });
auditLogSchema.index({ event: 1, createdAt: -1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

module.exports = { AuditLog, AUDIT_EVENTS };
