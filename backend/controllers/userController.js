const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require('crypto');
const asyncHandler = require("express-async-handler");
const User = require("../model/userModel");
const Mailjet = require('node-mailjet');

const mailjet = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC, 
  process.env.MJ_APIKEY_PRIVATE
);

console.log("process.env.MJ_APIKEY_PUBLIC", process.env.MJ_APIKEY_PUBLIC)

// Description: Register a user
// Route:       POST /api/users/
// Access:      Public
const registerUser = asyncHandler(async (req, res) => {
    const { firstName, lastName, email, password, pais, edad, terms} = req.body;
    
    if (!firstName || !lastName || !email || !password || !pais || !edad || !terms) {
        res.status(400);
        throw new Error("Please complete all required fields.");
    }

    if (!email || email == "" || !email.includes("@") || !email.includes(".")) {
        res.status(400);
        throw new Error("Please complete email field correctly.");
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
        terms
    });

    const request = mailjet
        .post('send', { version: 'v3.1' })
        .request({
            Messages: [
                {
                    From: {
                        Email: 'bluelighttech22@gmail.com',  // Tu email
                        Name: 'bluelighttech22',  // Tu nombre o el de tu empresa
                    },
                    To: [
                        {
                            Email: user.email,  // Email del usuario registrado
                            Name: `${user.firstName} ${user.lastName}`,  // Nombre del usuario
                        },
                    ],
                    Subject: 'Welcome to Our Service!',
                    TextPart: `Dear ${user.firstName}, welcome to our service! We're glad to have you on board.`,
                    HTMLPart: `<h3>Dear ${user.firstName}, welcome to our service!</h3><p>We're glad to have you on board.</p>`,
                },
            ],
        });
    request
        .then((result) => {
            console.log('Email sent successfully:', result.body);
        })
        .catch((err) => {
            console.error('Error sending email:', err.statusCode);
        });

    res.status(201).json({
        _id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        pais: user.pais,
        edad: user.edad,
        terms: user.terms
    });
})

const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });

  if (!user) {
      res.status(400);
      throw new Error("User not found");
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
          customerId: user.customerId
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
      throw new Error('No user found with that email address');
    }
  
    // Generar token para restablecer la contraseña
    const resetToken = crypto.randomBytes(32).toString('hex');
  
    // Guardar el token y su fecha de expiración en el usuario
    user.resetPasswordToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    user.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // Token válido por 10 minutos
  
    await user.save();
  
    // URL de frontend para que el usuario cambie la contraseña
    const resetUrl = `https://shantibackend.onrender.com/reset-password/${resetToken}`;  // Cambia el enlace si usas un dominio real
  
    // Enviar el correo electrónico con Mailjet
    try {
        const request = await mailjet
          .post('send', { version: 'v3.1' })
          .request({
            Messages: [
              {
                From: {
                  Email: 'bluelighttech22@gmail.com',  
                  Name: 'bluelighttech22',
                },
                To: [
                  {
                    Email: user.email,
                    Name: `${user.firstName} ${user.lastName}`,
                  },
                ],
                Subject: 'Recupera tu contraseña de NOVA AI',
                TextPart: `Hola ${user.firstName}, Haz clic en el siguiente enlace para restablecer tu contraseña: ${resetUrl}`,
                HTMLPart: `<h3>Hola ${user.firstName} ${user.lastName},</h3>
                          <h6>Parece que has solicitado restablecer tu contraseña en NOVA AI. No te preocupes, ¡estamos aquí para ayudarte!</h6>
                           <p>Haz clic en el siguiente enlace para restablecer tu contraseña:</p>
                           <a href="${resetUrl}">Resetear Contraseña</a>
                           <p>Este enlace es válido por 5 minutos. Si no solicitaste este cambio, simplemente ignora este correo. Tu cuenta está segura..</p>
                           <p>Un saludo, El equipo de NOVA AI</p>`,
              },
            ],
          });
      
        // Si el email se envía con éxito
        res.status(200).json({ success: true, data: 'Password reset email sent' });
      } catch (err) {
        console.error('Error sending password reset email:', err.statusCode);
      
        // Restablecer los campos del token en caso de error
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        await user.save();
      
        res.status(500);
        throw new Error('Email could not be sent');
      }
      
  });

const resetPassword = asyncHandler(async (req, res) => {
    const { password } = req.body;
  
    // Encriptar el token de la URL
    const resetPasswordToken = crypto
      .createHash('sha256')
      .update(req.params.token)
      .digest('hex');
  
    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpire: { $gt: Date.now() }, // Verifica que el token no haya expirado
    });
  
    if (!user) {
      res.status(400);
      throw new Error('Invalid token or token has expired');
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
      data: 'Password reset successful',
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
    resetPassword
}