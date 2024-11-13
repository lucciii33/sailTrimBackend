const express = require("express");
const router = express.Router();
const {
  reportAndIssue,
  customerService,
} = require("../controllers/reportController");
const { protect } = require("../middleware/authMiddleware");

router.route("/reportAndIssue").post(protect, reportAndIssue);
router.route("/customerService").post(protect, customerService);

module.exports = router;
