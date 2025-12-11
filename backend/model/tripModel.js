const mongoose = require("mongoose");

const TripSchema = new mongoose.Schema(
  {
    ship: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ship",
      required: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    responsibleCapitan: {
      type: String,
      required: true,
    },

    departurePort: { type: String, required: true },
    arrivalPort: { type: String, required: true },
    departureTime: { type: Date, required: true },
    arrivalTime: { type: Date, required: true },
    status: { type: String, required: true, default: "PLANNED" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Trip", TripSchema);
