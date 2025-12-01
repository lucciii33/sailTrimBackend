const mongoose = require("mongoose");

const userSchema = mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
    },
    lastName: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    password: {
      type: String,
      required: true,
    },
    edad: {
      type: Number,
      required: false,
    },
    pais: {
      type: String,
      required: false,
    },
    customerId: {
      type: String,
      required: false,
    },
    customerIdStripe: {
      type: String,
      required: false,
    },
    terms: {
      type: Boolean,
      required: false,
    },
    resetPasswordToken: {
      type: String,
      required: false,
    },
    resetPasswordExpire: {
      type: Date,
      required: false,
    },
    lastReset: {
      type: Date, // Este es el campo que necesitas para guardar la fecha de reinicio
    },
    hasTrial: {
      type: Boolean,
      default: false,
    },
    secretKeyStripe: {
      type: String,
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("User", userSchema);
