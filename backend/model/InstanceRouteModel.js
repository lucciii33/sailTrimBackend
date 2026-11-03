const mongoose = require("mongoose");

// Which dedicated instance a GitHub event belongs to. Only the main backend
// keeps these, because it is the one GitHub sends everything to.
//
// kind "installation": the GitHub App installation id.
// kind "github-user":  someone who started connecting from that instance. Lets
// the first event of a new installation find its way before its id is known.
const instanceRouteSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["installation", "github-user"], required: true },
    value: { type: String, required: true },
    instance: { type: String, required: true },
  },
  { timestamps: true }
);

instanceRouteSchema.index({ kind: 1, value: 1 }, { unique: true });

module.exports = mongoose.model("InstanceRoute", instanceRouteSchema);
