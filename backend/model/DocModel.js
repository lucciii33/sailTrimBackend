const mongoose = require("mongoose");

const paramSchema = new mongoose.Schema(
  {
    name: String,
    type: String,
    required: Boolean,
    description: String,
  },
  { _id: false }
);

const responseSchema = new mongoose.Schema(
  {
    status: Number,
    description: String,
    example: mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const docSchema = new mongoose.Schema({
  method: { type: String, required: true },
  path: { type: String, required: true },
  description: { type: String, required: true },
  requestBody: [paramSchema],
  queryParams: [paramSchema],
  responses: [responseSchema],
  prNumber: { type: Number, required: true },
  repo: { type: String, required: true },
  owner: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Doc", docSchema);
