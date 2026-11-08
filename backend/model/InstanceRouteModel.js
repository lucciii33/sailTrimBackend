const mongoose = require("mongoose");

// Which dedicated instance also gets a GitHub installation's events: one that
// someone connected from that instance. Only the main backend keeps these,
// because it is the one GitHub sends everything to.
const instanceRouteSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["installation"], required: true },
    value: { type: String, required: true },
    instance: { type: String, required: true },
  },
  { timestamps: true }
);

instanceRouteSchema.index({ kind: 1, value: 1 }, { unique: true });

module.exports = mongoose.model("InstanceRoute", instanceRouteSchema);
