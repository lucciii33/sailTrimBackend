const express = require("express");
const router = express.Router();
const { reportAndIssue } = require("../controllers/reportController");
const { protect } = require("../middleware/authMiddleware");

router.route("/reportAndIssue").post(protect, reportAndIssue);

module.exports = router;
