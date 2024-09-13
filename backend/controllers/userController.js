const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const asyncHandler = require("express-async-handler");
const User = require("../model/userModel");
const Mailjet = require('node-mailjet');

const mailjet = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC, 
  process.env.MJ_APIKEY_PRIVATE
);

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
    //   const currentWeekNumber = Math.floor(Date.now() / (1000 * 60 * 60 * 24 * 7));

    //   // Verifica si la semana ha cambiado
    //   if (user.lastWeekNumber !== currentWeekNumber) {
    //       user.loginDays = {
    //           "0": false,
    //           "1": false,
    //           "2": false,
    //           "3": false,
    //           "4": false,
    //           "5": false,
    //           "6": false
    //       };
    //       user.lastWeekNumber = currentWeekNumber; // Actualiza el número de semana
    //   }

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

  const generateToken = (id) => {
    return jwt.sign({ id }, `${process.env.JWT_SECRET_NODE}`, {
      expiresIn: "8h",
    });
  };

module.exports = {
    registerUser,
    loginUser
}