const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const User = require("../model/userModel");
const Mailjet = require("node-mailjet");

const mailjet = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC,
  process.env.MJ_APIKEY_PRIVATE
);

console.log("process.env.MJ_APIKEY_PUBLIC", process.env.MJ_APIKEY_PUBLIC);

// Description: Register a user
// Route:       POST /api/users/
// Access:      Public
const registerUser = asyncHandler(async (req, res) => {
  const { firstName, lastName, email, password, pais, edad, terms } = req.body;

  if (
    !firstName ||
    !lastName ||
    !email ||
    !password ||
    !pais ||
    !edad ||
    !terms
  ) {
    res.status(400);
    throw new Error("Please complete all required fields.");
  }

  if (!email || email == "" || !email.includes("@") || !email.includes(".")) {
    res.status(400);
    throw new Error("Please complete email field correctly.");
  }

  if (password.length < 9) {
    res.status(400);
    throw new Error("Password must be 9 characters or more.");
  }
  if (!/[A-Z]/.test(password)) {
    res.status(400);
    throw new Error("Password must contain at least one capital letter.");
  }
  if (!/\d/.test(password)) {
    res.status(400);
    throw new Error("Password must contain at least one number.");
  }
  if (!/[!@#$%^&*]/.test(password)) {
    res.status(400);
    throw new Error("Password must contain at least one symbol (!@#$%^&*).");
  }

  const userExists = await User.findOne({ email });

  if (userExists) {
    res.status(400);
    throw new Error("User already exists");
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const user = await User.create({
    firstName,
    lastName,
    email,
    password: hashedPassword,
    pais,
    edad,
    role: "USER",
    terms,
  });

  const request = mailjet.post("send", { version: "v3.1" }).request({
    Messages: [
      {
        From: {
          Email: "bluelighttech22@gmail.com", // Tu email
          Name: "bluelighttech22", // Tu nombre o el de tu empresa
        },
        To: [
          {
            Email: user.email, // Email del usuario registrado
            Name: `${user.firstName} ${user.lastName}`, // Nombre del usuario
          },
        ],
        Subject: "¡Bienvenido a Nova! 🎉",
        TextPart: `hola ${user.firstName}, Bienvenido a NOVA AI!`,
        HTMLPart: `
        <div style="font-family: Arial, sans-serif; color: #333333; line-height: 1.6; background-color: #F7F7F7; padding: 20px; text-align: center;">
            <img src="https://bluenova.s3.us-east-2.amazonaws.com/WhatsApp+Image+2024-09-18+at+22.34.16.jpeg" style="width: 50%; max-width: 300px; height: auto; border-radius: 10px; margin-bottom: 20px;"/>
        <h3 style="color: #007BFF; margin-bottom: 10px;">Hola ${user.firstName}, ¡Bienvenido a NOVA AI!</h3>
        <p style="font-size: 16px; margin-bottom: 20px;">Estamos emocionados de que te unas a nuestra comunidad de aprendizaje. En Nova, nos apasiona ayudarte a estudiar de manera más efectiva y alcanzar tus objetivos. Prepárate para descubrir nuevas técnicas, mejorar tus habilidades y disfrutar del proceso de aprendizaje.</p>
        <p style="font-size: 16px; margin-bottom: 20px;">¡Empecemos juntos este viaje! 🚀</p>
        <p style="font-size: 14px; color: #555555; margin-bottom: 20px;">Si tienes alguna pregunta o necesitas ayuda, no dudes en contactarnos.</p>
        <p style="font-weight: bold; font-size: 16px;">A por todas!</p>
        <p style="font-size: 12px; color: #777777; margin-top: 20px;"><small>El equipo de Nova</small></p>
        </div>
        `,
      },
    ],
  });
  request
    .then((result) => {
      console.log("Email sent successfully:", result.body);
    })
    .catch((err) => {
      console.error("Error sending email:", err.statusCode);
    });

  res.status(201).json({
    _id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    pais: user.pais,
    edad: user.edad,
    terms: user.terms,
  });
});

const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    res.status(400);
    throw new Error("Correo electrónico o contraseña incorrectos.");
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (user && isMatch) {
    const currentDay = new Date().getDay().toString();
    // const today = new Date();
    // const lastMonday = new Date(today.setDate(today.getDate() - (today.getDay() + 6) % 7));

    // // Si no se ha reiniciado los días desde el último lunes, reiniciamos
    // if (currentDay === '1' || !user.lastReset || new Date(user.lastReset) < lastMonday) {
    //   user.loginDays = {
    //     "0": false,
    //     "1": false,
    //     "2": false,
    //     "3": false,
    //     "4": false,
    //     "5": false,
    //     "6": false
    //   };
    //   user.lastReset = new Date(); // Actualizamos la fecha de reinicio
    //   console.log("Los días de login se han reiniciado porque ha pasado un nuevo lunes");
    // }

    user.loginDays.set(currentDay, true);
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
  const resetUrl = `https://mentorai.netlify.app/reset-password/${resetToken}`;
  console.log("Generated Reset URL:", resetUrl); // Cambia el enlace si usas un dominio real

  // Enviar el correo electrónico con Mailjet
  try {
    const request = await mailjet.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: {
            Email: "bluelighttech22@gmail.com",
            Name: "bluelighttech22",
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

const generateToken = (id) => {
  return jwt.sign({ id }, `${process.env.JWT_SECRET_NODE}`, {
    expiresIn: "8h",
  });
};

module.exports = {
  registerUser,
  loginUser,
  forgotPassword,
  resetPassword,
};
