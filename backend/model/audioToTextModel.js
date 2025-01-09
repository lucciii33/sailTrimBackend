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
    title: {
      type: String,
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("AudioToText", AudioToTextSchema);
