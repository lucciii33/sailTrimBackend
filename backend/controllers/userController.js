const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const asyncHandler = require("express-async-handler");
const User = require("../model/userModel");

// Description: Register a user
// Route:       POST /api/users/
// Access:      Public
const registerUser = asyncHandler(async (req, res) => {
    const { firstName, lastName, email, password, phoneNumber } = req.body;
    
    if (!firstName || !lastName || !email || !password || !phoneNumber) {
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
        phoneNumber,
        role: "USER",
    });

    res.status(201).json({
        _id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phoneNumber: user.phoneNumber,
    });
})

const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
  
    //Check for a practitioner user email
    const user = await User.findOne({ email });
  
    if (!user) {
      res.status(400);
      throw new Error("User not found");
    }
  
    if (user && (await bcrypt.compare(password, user.password))) {
      res.json({
        _id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        token: generateToken(user._id),
      });
    } else {
      res.status(400);
      throw new Error("Invalid credentials");
    }
  });

  const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
      expiresIn: "8h",
    });
  };

module.exports = {
    registerUser,
    loginUser
}