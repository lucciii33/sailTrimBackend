const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const User = require("../model/userModel");
const Company = require("../model/companyModel");
const CompanyInvite = require("../model/companyInviteModel");
const { encrypt, maskSecret } = require("../services/secretCrypto");
const {
  validatePasswordStrength,
  hashPassword,
  isReusedPassword,
  pushPasswordHistory,
} = require("../services/passwordPolicy");
const { logEvent } = require("../services/auditLogger");
const { OAuth2Client } = require("google-auth-library");

// Lazy Google OIDC client — verifies the ID token the browser gets from
// "Sign in with Google". Only the client_id is needed to check the audience.
let _googleClient = null;
function getGoogleClient() {
  if (!_googleClient) {
    _googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }
  return _googleClient;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

const Mailjet = require("node-mailjet");
const FRONTEND_URL = process.env.FRONTEND_URL || "https://novaaiapp.com";
const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || "novaappai@gmail.com";
const FROM_NAME = process.env.MAIL_FROM_NAME || "Olivia Tools";

let _mailjet = null;
function getMailjet() {
  if (!_mailjet) {
    _mailjet = Mailjet.apiConnect(
      process.env.MJ_APIKEY_PUBLIC,
      process.env.MJ_APIKEY_PRIVATE
    );
  }
  return _mailjet;
}

// Description: Register a user
// Route:       POST /api/user/register
// Access:      Public
const registerUser = asyncHandler(async (req, res) => {
  const {
    name,
    fullName,
    displayName,
    firstName: bodyFirstName,
    lastName: bodyLastName,
    email,
    password,
    pais,
    country,
    edad,
    age,
    terms,
    termsAccepted,
    inviteToken,
  } = req.body;
  const normalizedEmail = email ? email.toLowerCase().trim() : "";
  const fallbackName = name || fullName || displayName || "";
  const [fallbackFirstName, ...fallbackLastNameParts] = fallbackName.trim().split(/\s+/);
  const firstName = bodyFirstName || fallbackFirstName;
  const lastName =
    bodyLastName || fallbackLastNameParts.join(" ") || firstName || "User";
  const normalizedPais = pais || country;
  const normalizedEdad = edad || age;
  const normalizedTerms = terms ?? termsAccepted ?? false;

  if (!firstName || !lastName || !normalizedEmail || !password) {
    res.status(400);
    throw new Error("Please complete all fields.");
  }

  if (
    normalizedEmail == "" ||
    !normalizedEmail.includes("@") ||
    !normalizedEmail.includes(".")
  ) {
    res.status(400);
    throw new Error("Please enter a valid email address.");
  }

  const passwordError = validatePasswordStrength(password);
  if (passwordError) {
    res.status(400);
    throw new Error(passwordError);
  }

  const userExists = await User.findOne({ email: normalizedEmail });

  if (userExists) {
    res.status(400);
    throw new Error("User already exists");
  }

  const hashedPassword = await hashPassword(password);

  let companyId = null;
  let userRole = "owner";

  if (inviteToken) {
    const invite = await CompanyInvite.findOne({
      token: inviteToken,
      acceptedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!invite) {
      res.status(400);
      throw new Error("Invalid or expired invitation.");
    }
    if (invite.email.toLowerCase() !== normalizedEmail) {
      res.status(400);
      throw new Error("This invitation is for a different email.");
    }
    companyId = invite.companyId;
    userRole = invite.role || "member";
  }

  const user = await User.create({
    firstName,
    lastName,
    email: normalizedEmail,
    password: hashedPassword,
    pais: normalizedPais,
    edad: normalizedEdad,
    terms: normalizedTerms,
    companyId,
    role: userRole,
    passwordHistory: [{ hash: hashedPassword, changedAt: new Date() }],
    passwordChangedAt: new Date(),
  });

  if (!companyId) {
    const company = await Company.create({
      name: `${firstName}'s Workspace`,
      ownerUserId: user._id,
    });
    user.companyId = company._id;
    await user.save();
  } else {
    await CompanyInvite.updateOne(
      { token: inviteToken },
      { $set: { acceptedAt: new Date() } }
    );
  }

  // const request = mailjet.post("send", { version: "v3.1" }).request({
  //   Messages: [
  //     {
  //       From: {
  //         Email: "novaappai@gmail.com", // Tu email
  //         Name: "NOVA AI", // Tu nombre o el de tu empresa
  //       },
  //       To: [
  //         {
  //           Email: user.email, // Email del usuario registrado
  //           Name: `${user.firstName} ${user.lastName}`, // Nombre del usuario
  //         },
  //       ],
  //       Subject: "¡Bienvenido a Nova! 🎉",
  //       TextPart: `hola ${user.firstName}, Bienvenido a NOVA AI!`,
  //       HTMLPart: `
  //       <div style="font-family: Arial, sans-serif; color: #333333; line-height: 1.6; background-color: #F7F7F7; padding: 20px; text-align: center;">
  //           <img src="https://bluenova.s3.us-east-2.amazonaws.com/WhatsApp+Image+2024-09-18+at+22.34.16.jpeg" style="width: 50%; max-width: 300px; height: auto; border-radius: 10px; margin-bottom: 20px;"/>
  //       <h3 style="color: #007BFF; margin-bottom: 10px;">Hola ${user.firstName}, ¡Bienvenido a NOVA AI!</h3>
  //       <p style="font-size: 16px; margin-bottom: 20px;">Estamos emocionados de que te unas a nuestra comunidad de aprendizaje. En Nova, nos apasiona ayudarte a estudiar de manera más efectiva y alcanzar tus objetivos. Prepárate para descubrir nuevas técnicas, mejorar tus habilidades y disfrutar del proceso de aprendizaje.</p>
  //       <p style="font-size: 16px; margin-bottom: 20px;">¡Empecemos juntos este viaje! 🚀</p>
  //       <p style="font-size: 14px; color: #555555; margin-bottom: 20px;">Si tienes alguna pregunta o necesitas ayuda, no dudes en contactarnos.</p>
  //       <p style="font-weight: bold; font-size: 16px;">A por todas!</p>
  //       <p style="font-size: 12px; color: #777777; margin-top: 20px;"><small>El equipo de Nova</small></p>
  //       </div>
  //       `,
  //     },
  //   ],
  // });
  // request
  //   .then((result) => {
  //     console.log("Email sent successfully:", result.body);
  //   })
  //   .catch((err) => {
  //     console.error("Error sending email:", err.statusCode);
  //   });

  await logEvent({
    event: "user_register",
    req,
    user,
    metadata: { inviteToken: !!inviteToken },
  });

  res.status(201).json({
    _id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    pais: user.pais,
    edad: user.edad,
    terms: user.terms,
    companyId: user.companyId,
    role: user.role,
    token: generateToken(user._id),
  });
});

const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = email.toLowerCase();
  const user = await User.findOne({ email: normalizedEmail });

  if (!user) {
    res.status(400);
    throw new Error("Invalid email or password.");
  }

  if (user.lockUntil && user.lockUntil > new Date()) {
    await logEvent({
      event: "user_login_locked",
      req,
      user,
      success: false,
    });
    const minutesLeft = Math.ceil((user.lockUntil - new Date()) / 60000);
    res.status(423);
    throw new Error(
      `Account temporarily locked. Try again in ${minutesLeft} minutes.`
    );
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
      user.lockUntil = new Date(Date.now() + LOCK_DURATION_MS);
      user.failedLoginAttempts = 0;
    }
    await user.save();
    await logEvent({
      event: "user_login_failed",
      req,
      user,
      success: false,
      metadata: { failedAttempts: user.failedLoginAttempts },
    });
    res.status(400);
    throw new Error("Invalid email or password.");
  }

  user.failedLoginAttempts = 0;
  user.lockUntil = undefined;
  await user.save();

  await logEvent({
    event: "user_login_success",
    req,
    user,
    metadata: { requires2FA: !!user.twoFactorEnabled },
  });

  if (user.twoFactorEnabled) {
    const twoFactorToken = jwt.sign(
      { id: user._id, twoFactorPending: true },
      process.env.JWT_SECRET_NODE,
      { expiresIn: "5m" }
    );
    return res.json({
      requires2FA: true,
      twoFactorToken,
    });
  }

  res.json({
    _id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    pais: user.pais,
    edad: user.edad,
    token: generateToken(user._id),
    loginDays: user.loginDays,
    customerId: user.customerId,
    secretKeyStripe: user.secretKeyStripe,
    daysStudy: user.daysStudy,
    companyId: user.companyId,
    role: user.role,
  });
});

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const normalizedEmail = email ? email.toLowerCase().trim() : "";

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return res.status(200).json({
      success: true,
      data: "If that email exists, a reset link has been sent.",
    });
  }

  const resetToken = crypto.randomBytes(32).toString("hex");

  user.resetPasswordToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");
  user.resetPasswordExpire = Date.now() + 10 * 60 * 1000;

  await user.save();

  await logEvent({
    event: "password_reset_requested",
    req,
    user,
  });

  const resetUrl = `${FRONTEND_URL}/reset-password/${resetToken}`;
  if (process.env.NODE_ENV !== "production") {
    console.log("[dev] Reset URL:", resetUrl);
  }

  try {
    const request = await getMailjet().post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: {
            Email: FROM_EMAIL,
            Name: FROM_NAME,
          },
          To: [
            {
              Email: user.email,
              Name: `${user.firstName} ${user.lastName}`,
            },
          ],
          Subject: "Reset your Olivia Tools password",
          TextPart: `Hi ${user.firstName}, click the link below to reset your password: ${resetUrl}`,
          HTMLPart: `
          <div style="font-family: Arial, sans-serif; color: #333333; line-height: 1.6; background-color: #F7F7F7; padding: 20px; text-align: center;">
            <h3 style="color: #0d1a36; margin-bottom: 10px;">Hi ${user.firstName} ${user.lastName},</h3>
            <h6 style="font-size: 16px; color: #555555; margin-bottom: 20px;">You requested to reset your password on Olivia Tools.</h6>
            <p style="font-size: 16px; margin-bottom: 20px;">Click the button below to set a new password:</p>
            <a href="${resetUrl}" style="display: inline-block; background-color: #0d1a36; color: #FFFFFF; text-decoration: none; padding: 10px 20px; border-radius: 5px; font-size: 16px; margin-bottom: 20px;">Reset password</a>
            <p style="font-size: 14px; color: #555555; margin-bottom: 20px;">This link is valid for 10 minutes. If you didn't request this, just ignore this email.</p>
            <p style="font-size: 12px; color: #777777; margin-top: 20px;"><small>The Olivia Tools team</small></p>
          </div>
          `,
        },
      ],
    });

    res.status(200).json({
      success: true,
      data: "If that email exists, a reset link has been sent.",
    });
  } catch (err) {
    console.error("Error sending password reset email:", err?.statusCode || err?.message);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();
    res.status(200).json({
      success: true,
      data: "If that email exists, a reset link has been sent.",
    });
  }
});

const resetPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;

  const passwordError = validatePasswordStrength(password);
  if (passwordError) {
    res.status(400);
    throw new Error(passwordError);
  }

  const resetPasswordToken = crypto
    .createHash("sha256")
    .update(req.params.token)
    .digest("hex");

  const user = await User.findOne({
    resetPasswordToken,
    resetPasswordExpire: { $gt: Date.now() },
  }).select("+passwordHistory");

  if (!user) {
    res.status(400);
    throw new Error("Invalid token or token has expired");
  }

  if (await bcrypt.compare(password, user.password)) {
    res.status(400);
    throw new Error("New password cannot be the same as your current one.");
  }

  if (await isReusedPassword(password, user.passwordHistory)) {
    res.status(400);
    throw new Error(
      "You can't reuse one of your last 5 passwords. Please choose a different one."
    );
  }

  const newHash = await hashPassword(password);
  user.password = newHash;
  user.passwordHistory = pushPasswordHistory(user.passwordHistory, newHash);
  user.passwordChangedAt = new Date();

  await logEvent({
    event: "password_reset_completed",
    req,
    user,
  });
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;
  user.failedLoginAttempts = 0;
  user.lockUntil = undefined;

  await user.save();

  res.status(200).json({
    success: true,
    data: "Password reset successful",
  });
});

// const resetLoginDays = async (req, res) => {
//   try {
//     // Reiniciar los días de login de todos los usuarios
//     const updateResult = await User.updateMany({}, {
//       $set: {
//         "loginDays.0": false,
//         "loginDays.1": false,
//         "loginDays.2": false,
//         "loginDays.3": false,
//         "loginDays.4": false,
//         "loginDays.5": false,
//         "loginDays.6": false
//       }
//     });

//     console.log(`Documentos modificados: ${updateResult.nModified}`);
//     res.send("Días de login reiniciados!");
//   } catch (error) {
//     console.error("Error reiniciando los días de login:", error);
//     res.status(500).send("Error reiniciando los días de login");
//   }
// };

// const generateToken = (id) => {
//   return jwt.sign({ id }, `${process.env.JWT_SECRET_NODE}`, {
//     expiresIn: "8h",
//   });
// };

const generateToken = (id) => {
  const t = jwt.sign({ id }, process.env.JWT_SECRET_NODE, { expiresIn: "1h" });
  console.log("🔥 TOKEN GENERADO BACKEND:", t);
  return t;
};

// Description: Save the user's own Anthropic API key (encrypted at rest)
// Route:       PUT /api/user/me/anthropic-key
// Access:      Private
const saveAnthropicKey = asyncHandler(async (req, res) => {
  const apiKey = (req.body?.apiKey || "").trim();
  if (!apiKey) {
    res.status(400);
    throw new Error("apiKey is required");
  }
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }
  user.anthropicKeyEncrypted = encrypt(apiKey);
  user.anthropicKeyMask = maskSecret(apiKey);
  await user.save();
  await logEvent({ event: "anthropic_key_saved", req, user });
  res.json({ anthropicKeyMask: user.anthropicKeyMask, hasAnthropicKey: true });
});

// Description: Remove the user's stored Anthropic API key
// Route:       DELETE /api/user/me/anthropic-key
// Access:      Private
const deleteAnthropicKey = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }
  user.anthropicKeyEncrypted = undefined;
  user.anthropicKeyMask = undefined;
  await user.save();
  await logEvent({ event: "anthropic_key_removed", req, user });
  res.json({ anthropicKeyMask: null, hasAnthropicKey: false });
});

// Description: Read the current user's settings (mask only)
// Route:       GET /api/user/me/settings
// Access:      Private
const getMySettings = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "anthropicKeyMask twoFactorEnabled"
  );
  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }
  res.json({
    anthropicKeyMask: user.anthropicKeyMask || null,
    hasAnthropicKey: !!user.anthropicKeyMask,
    twoFactorEnabled: !!user.twoFactorEnabled,
  });
});

// ===================== Google SSO / OIDC login =====================
// The browser obtains a signed ID token from Google ("Sign in with Google").
// We verify it, enforce the company domain, then find/link/create the Mongo
// user and issue our own JWT — same session as a normal login from there on.
const googleLogin = asyncHandler(async (req, res) => {
  const token = req.body.credential || req.body.idToken;
  if (!token) {
    res.status(400);
    throw new Error("Missing Google credential");
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    res.status(500);
    throw new Error("Google SSO not configured (GOOGLE_CLIENT_ID missing)");
  }

  let payload;
  try {
    const ticket = await getGoogleClient().verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    res.status(401);
    throw new Error("Invalid Google token");
  }

  const email = (payload.email || "").toLowerCase().trim();
  if (!email || !payload.email_verified) {
    res.status(401);
    throw new Error("Google account email not verified");
  }

  // Enterprise lock: only allow the company's Workspace domain. Comma-separated
  // list in GOOGLE_ALLOWED_HD (e.g. "company.com"). If unset, any Google login
  // is allowed (dev only — set this in production).
  const allowed = (process.env.GOOGLE_ALLOWED_HD || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length) {
    const emailDomain = email.split("@")[1];
    const hd = (payload.hd || "").toLowerCase();
    if (!allowed.includes(hd) && !allowed.includes(emailDomain)) {
      res.status(403);
      throw new Error("This Google account is not from an allowed domain");
    }
  }

  // 1) match by googleId, 2) link an existing local account by email,
  // 3) create a new SSO user (just-in-time provisioning).
  let user = await User.findOne({ googleId: payload.sub });
  if (!user) {
    user = await User.findOne({ email });
    if (user) {
      user.googleId = payload.sub;
      if (!user.password) user.authProvider = "google";
      await user.save();
    }
  }

  if (!user) {
    user = await User.create({
      firstName: payload.given_name || email.split("@")[0],
      lastName: payload.family_name || "",
      email,
      googleId: payload.sub,
      authProvider: "google",
      terms: true,
    });
    // New SSO user gets their own workspace, same as registerUser.
    const company = await Company.create({
      name: `${user.firstName}'s Workspace`,
      ownerUserId: user._id,
    });
    user.companyId = company._id;
    await user.save();
  }

  // If the account has app-level 2FA enabled, don't issue the session token
  // yet — return the same 2FA challenge the password login uses, so Google
  // sign-in also enforces the second factor.
  if (user.twoFactorEnabled) {
    await logEvent({
      event: "user_login_success",
      req,
      user,
      metadata: { provider: "google", requires2FA: true },
    });
    const twoFactorToken = jwt.sign(
      { id: user._id, twoFactorPending: true },
      process.env.JWT_SECRET_NODE,
      { expiresIn: "5m" }
    );
    return res.json({ requires2FA: true, twoFactorToken });
  }

  await logEvent({
    event: "user_login_success",
    req,
    user,
    metadata: { provider: "google" },
  });

  res.json({
    _id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    companyId: user.companyId,
    role: user.role,
    token: generateToken(user._id),
  });
});

module.exports = {
  registerUser,
  loginUser,
  googleLogin,
  forgotPassword,
  resetPassword,
  saveAnthropicKey,
  deleteAnthropicKey,
  getMySettings,
};
