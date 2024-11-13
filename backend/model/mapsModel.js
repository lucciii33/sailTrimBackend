const mongoose = require("mongoose");

const mapsMentalSchema = mongoose.Schema(
  {
    topic: {
      type: String,
      required: false,
    },
    textAi: {
      nodos: [
        {
          id: { type: String, required: false },
          label: { type: String, required: false },
        },
      ],
      conexiones: [
        {
          source: { type: String, required: false },
          target: { type: String, required: false },
        },
      ],
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("MapsMental", mapsMentalSchema);
