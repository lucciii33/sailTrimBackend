const mongoose = require("mongoose");

const calensarSchema = mongoose.Schema(
  {
    sessionName: {
      type: String,
      required: false,
    },
    description: {
      type: String,
      required: false,
    },
    completed: {
      type: Boolean,
      required: false,
      default: false,
    },
    date: {
      type: Date,
      required: false,
    },
    time: {
      type: String,
      required: false,
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

module.exports = mongoose.model("Calendar", calensarSchema);
