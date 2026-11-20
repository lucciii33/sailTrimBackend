const { AuditLog } = require("../model/AuditLogModel");

function getClientIp(req) {
  if (!req) return undefined;
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.ip || req.connection?.remoteAddress;
}

async function logEvent({
  event,
  req,
  user,
  companyId,
  actorEmail,
  targetType,
  targetId,
  metadata,
  success = true,
}) {
  try {
    await AuditLog.create({
      event,
      userId: user?._id || user?.id,
      companyId: companyId || user?.companyId,
      actorEmail: actorEmail || user?.email,
      ip: getClientIp(req),
      userAgent: req?.headers?.["user-agent"]?.slice(0, 300),
      targetType,
      targetId: targetId ? String(targetId) : undefined,
      metadata,
      success,
    });
  } catch (err) {
    console.error("[auditLogger] failed to write event", event, err?.message);
  }
}

module.exports = { logEvent };
