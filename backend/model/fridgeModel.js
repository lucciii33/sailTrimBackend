const mongoose = require("mongoose");

const FridgeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: false,
      trim: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    expirationDate: {
      type: Date,
      required: false,
    },
    unit: {
      type: String,
      required: false,
    },
    quantity: {
      type: Number,
      required: false,
      default: 1,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Fridge", FridgeSchema);
