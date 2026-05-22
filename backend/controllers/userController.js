const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const User = require("../model/userModel");
const Company = require("../model/companyModel");
const CompanyInvite = require("../model/companyInviteModel");
const { encrypt, maskSecret } = require("../services/secretCrypto");
// const Mailjet = require("node-mailjet");

// const mailjet = Mailjet.apiConnect(
//   process.env.MJ_APIKEY_PUBLIC,
//   process.env.MJ_APIKEY_PRIVATE
// );

// console.log("process.env.MJ_APIKEY_PUBLIC", process.env.MJ_APIKEY_PUBLIC);

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
    throw new Error("Por Favor completa todo los campos.");
  }

  if (
    normalizedEmail == "" ||
    !normalizedEmail.includes("@") ||
    !normalizedEmail.includes(".")
  ) {
    res.status(400);
    throw new Error(
      "Por favor, completa el campo de correo electrónico correctamente."
    );
  }

  if (password.length < 9) {
    res.status(400);
    throw new Error("La contraseña debe tener 9 caracteres o más.");
  }
  if (!/[A-Z]/.test(password)) {
    res.status(400);
    throw new Error(
      "La contraseña debe contener al menos una letra mayúscula."
    );
  }
  if (!/\d/.test(password)) {
    res.status(400);
    throw new Error("La contraseña debe contener al menos un número.");
  }
  if (!/[!@#$%^&*]/.test(password)) {
    res.status(400);
    throw new Error(
      "La contraseña debe contener al menos un símbolo (!@#$%^&*)."
    );
  }

  const userExists = await User.findOne({ email: normalizedEmail });

  if (userExists) {
    res.status(400);
    throw new Error("User already exists");
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

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
      throw new Error("Invitación inválida o expirada");
    }
    if (invite.email.toLowerCase() !== normalizedEmail) {
      res.status(400);
      throw new Error("La invitación es para otro email");
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

  if (!user || !(await bcrypt.compare(password, user.password))) {
    res.status(400);
    throw new Error("Correo electrónico o contraseña incorrectos.");
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (user && isMatch) {
    await user.save();

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
  } else {
    res.status(400);
    throw new Error("Invalid credentials");
  }
});

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email });
  if (!user) {
    res.status(404);
    throw new Error("No user found with that email address");
  }

  // Generar token para restablecer la contraseña
  const resetToken = crypto.randomBytes(32).toString("hex");

  // Guardar el token y su fecha de expiración en el usuario
  user.resetPasswordToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");
  user.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // Token válido por 10 minutos

  await user.save();

  // URL de frontend para que el usuario cambie la contraseña
  const resetUrl = `https://novaaiapp.com/reset-password/${resetToken}`;
  console.log("Generated Reset URL:", resetUrl); // Cambia el enlace si usas un dominio real

  // Enviar el correo electrónico con Mailjet
  try {
    const request = await mailjet.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: {
            Email: "novaappai@gmail.com",
            Name: "NOVA AI",
          },
          To: [
            {
              Email: user.email,
              Name: `${user.firstName} ${user.lastName}`,
            },
          ],
          Subject: "Recupera tu contraseña de NOVA AI",
          TextPart: `Hola ${user.firstName}, Haz clic en el siguiente enlace para restablecer tu contraseña: ${resetUrl}`,
          HTMLPart: `
          <div style="font-family: Arial, sans-serif; color: #333333; line-height: 1.6; background-color: #F7F7F7; padding: 20px; text-align: center;">
            <h3 style="color: #0d1a36; margin-bottom: 10px;">Hola ${user.firstName} ${user.lastName},</h3>
            <h6 style="font-size: 16px; color: #555555; margin-bottom: 20px;">Parece que has solicitado restablecer tu contraseña en NOVA AI. No te preocupes, ¡estamos aquí para ayudarte!</h6>
            <p style="font-size: 16px; margin-bottom: 20px;">Haz clic en el siguiente enlace para restablecer tu contraseña:</p>
            <a href="${resetUrl}" style="display: inline-block; background-color: #0d1a36; color: #FFFFFF; text-decoration: none; padding: 10px 20px; border-radius: 5px; font-size: 16px; margin-bottom: 20px;">Resetear Contraseña</a>
            <p style="font-size: 14px; color: #555555; margin-bottom: 20px;">Este enlace es válido por 5 minutos. Si no solicitaste este cambio, simplemente ignora este correo. Tu cuenta está segura.</p>
            <p style="font-size: 14px; color: #555555; margin-bottom: 20px;">Si necesitas más ayuda, estamos disponibles para asistirte.</p>
            <p style="font-size: 12px; color: #777777; margin-top: 20px;"><small>Un saludo, el equipo de Nova</small></p>
          </div>

          `,
        },
      ],
    });

    // Si el email se envía con éxito
    res.status(200).json({ success: true, data: "Password reset email sent" });
  } catch (err) {
    console.error("Error sending password reset email:", err.statusCode);

    // Restablecer los campos del token en caso de error
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    res.status(500);
    throw new Error("Email could not be sent");
  }
});

const resetPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;

  // Encriptar el token de la URL
  const resetPasswordToken = crypto
    .createHash("sha256")
    .update(req.params.token)
    .digest("hex");

  const user = await User.findOne({
    resetPasswordToken,
    resetPasswordExpire: { $gt: Date.now() }, // Verifica que el token no haya expirado
  });

  if (!user) {
    res.status(400);
    throw new Error("Invalid token or token has expired");
  }

  // Establecer la nueva contraseña
  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(password, salt);

  // Limpiar los campos de reset token y expiración
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;

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
  const t = jwt.sign({ id }, process.env.JWT_SECRET_NODE, { expiresIn: "8h" });
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
  res.json({ anthropicKeyMask: null, hasAnthropicKey: false });
});

// Description: Read the current user's settings (mask only)
// Route:       GET /api/user/me/settings
// Access:      Private
const getMySettings = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("anthropicKeyMask");
  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }
  res.json({
    anthropicKeyMask: user.anthropicKeyMask || null,
    hasAnthropicKey: !!user.anthropicKeyMask,
  });
});

module.exports = {
  registerUser,
  loginUser,
  forgotPassword,
  resetPassword,
  saveAnthropicKey,
  deleteAnthropicKey,
  getMySettings,
};
