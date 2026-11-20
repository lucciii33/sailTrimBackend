const mongoose = require("mongoose");

// How many jobs a workspace currently holds, as ONE number updated atomically.
//
// The obvious implementations are both wrong under concurrency: counting jobs
// and then inserting lets four simultaneous clicks all read "nothing running",
// and inserting then counting has the inserts and the counts interleave. Either
// way a 2-job plan runs four, which is exactly what happened.
//
// A single conditional $inc cannot interleave: Mongo applies one update at a
// time to a document, so the fourth claim sees running = limit and matches
// nothing. That is the whole reason this collection exists.
const jobSlotSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      unique: true,
    },
    running: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("JobSlot", jobSlotSchema);
