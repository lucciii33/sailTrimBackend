const crypto = require("crypto");

const ALGO = "aes-256-gcm";

function getKey() {
  const raw = process.env.QA_ENC_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      "QA_ENC_KEY env var is required and must be at least 32 chars. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\""
    );
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(plain) {
  if (plain == null || plain === "") return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(payload) {
  if (!payload) return "";
  const parts = String(payload).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return "";
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const enc = Buffer.from(parts[3], "base64");
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

function maskSecret(s) {
  if (!s) return "";
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

module.exports = { encrypt, decrypt, maskSecret };
