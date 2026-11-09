const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { getJob, listRunningJobs } = require("../controllers/jobController");

// Long work (suite runs, bug hunts) answers with a job id; these read it back.
router.get("/running", protect, listRunningJobs);
router.get("/:id", protect, getJob);

module.exports = router;
