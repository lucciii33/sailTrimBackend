const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const asyncHandler = require("express-async-handler");
const User = require("../model/userModel");
const { encrypt, decrypt } = require("../services/secretCrypto");
const { logEvent } = require("../services/auditLogger");

const ISSUER = process.env.TWO_FACTOR_ISSUER || "OliviaTools";
const BACKUP_CODE_COUNT = 8;

function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    codes.push(crypto.randomBytes(5).toString("hex"));
  }
  return codes;
}

async function hashBackupCodes(codes) {
  const salt = await bcrypt.genSalt(10);
  return Promise.all(codes.map((c) => bcrypt.hash(c, salt)));
}

// POST /api/user/me/2fa/setup
const setupTwoFactor = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }
  if (user.twoFactorEnabled) {
    res.status(400);
    throw new Error("2FA is already enabled. Disable it before reconfiguring.");
  }

  const secret = speakeasy.generateSecret({
    name: `${ISSUER} (${user.email})`,
    issuer: ISSUER,
    length: 20,
  });

  user.twoFactorSecret = encrypt(secret.base32);
  await user.save();

  await logEvent({ event: "two_factor_setup_started", req, user });

  const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);

  res.json({
    qrDataUrl,
    otpauthUrl: secret.otpauth_url,
    secret: secret.base32,
  });
});

// POST /api/user/me/2fa/verify
const verifyTwoFactorSetup = asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code) {
    res.status(400);
    throw new Error("Code is required.");
  }

  const user = await User.findById(req.user._id).select(
    "+twoFactorSecret +twoFactorBackupCodes"
  );
  if (!user || !user.twoFactorSecret) {
    res.status(400);
    throw new Error("Generate a secret first via /2fa/setup.");
  }

  const decodedSecret = decrypt(user.twoFactorSecret);
  const verified = speakeasy.totp.verify({
    secret: decodedSecret,
    encoding: "base32",
    token: String(code).replace(/\s/g, ""),
    window: 1,
  });

  if (!verified) {
    res.status(400);
    throw new Error("Invalid code.");
  }

  const backupCodes = generateBackupCodes();
  user.twoFactorBackupCodes = await hashBackupCodes(backupCodes);
  user.twoFactorEnabled = true;
  await user.save();

  await logEvent({ event: "two_factor_enabled", req, user });

  res.json({
    twoFactorEnabled: true,
    backupCodes,
  });
});

// POST /api/user/me/2fa/disable
const disableTwoFactor = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password) {
    res.status(400);
    throw new Error("Password is required to disable 2FA.");
  }

  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    res.status(400);
    throw new Error("Incorrect password.");
  }

  user.twoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  user.twoFactorBackupCodes = [];
  await user.save();

  await logEvent({ event: "two_factor_disabled", req, user });

  res.json({ twoFactorEnabled: false });
});

// POST /api/user/login/2fa
const loginVerifyTwoFactor = asyncHandler(async (req, res) => {
  const { twoFactorToken, code } = req.body;
  if (!twoFactorToken || !code) {
    res.status(400);
    throw new Error("Token and code are required.");
  }

  let payload;
  try {
    payload = jwt.verify(twoFactorToken, process.env.JWT_SECRET_NODE);
  } catch (e) {
    res.status(401);
    throw new Error("Invalid or expired token.");
  }
  if (!payload.twoFactorPending) {
    res.status(401);
    throw new Error("Invalid token.");
  }

  const user = await User.findById(payload.id).select(
    "+twoFactorSecret +twoFactorBackupCodes"
  );
  if (!user || !user.twoFactorEnabled) {
    res.status(400);
    throw new Error("2FA is not enabled for this user.");
  }

  const cleanCode = String(code).replace(/\s/g, "");
  let verified = false;

  if (/^\d{6}$/.test(cleanCode)) {
    const decodedSecret = decrypt(user.twoFactorSecret);
    verified = speakeasy.totp.verify({
      secret: decodedSecret,
      encoding: "base32",
      token: cleanCode,
      window: 1,
    });
  } else {
    for (let i = 0; i < user.twoFactorBackupCodes.length; i++) {
      const hash = user.twoFactorBackupCodes[i];
      if (await bcrypt.compare(cleanCode, hash)) {
        user.twoFactorBackupCodes.splice(i, 1);
        await user.save();
        verified = true;
        break;
      }
    }
  }

  if (!verified) {
    await logEvent({
      event: "two_factor_verify_failed",
      req,
      user,
      success: false,
    });
    res.status(400);
    throw new Error("Invalid 2FA code.");
  }

  await logEvent({ event: "two_factor_verify_success", req, user });

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET_NODE, {
    expiresIn: "1h",
  });

  res.json({
    _id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    pais: user.pais,
    edad: user.edad,
    token,
    customerId: user.customerId,
    secretKeyStripe: user.secretKeyStripe,
    companyId: user.companyId,
    role: user.role,
  });
});

module.exports = {
  setupTwoFactor,
  verifyTwoFactorSetup,
  disableTwoFactor,
  loginVerifyTwoFactor,
};
