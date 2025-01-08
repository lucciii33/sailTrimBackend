const mongoose = require("mongoose");

const AudioToTextSchema = mongoose.Schema(
  {
    transcript: {
      type: String,
      required: false,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("AudioToText", AudioToTextSchema);
