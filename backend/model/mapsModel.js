const mongoose = require("mongoose");

const mapsMentalSchema = mongoose.Schema(
  {
    topic: {
      type: String,
      required: false,
    },
    textAi: {
      nodes: [
        {
          id: { type: String, required: false },
          label: { type: String, required: false },
        },
      ],
      connections: [
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
