const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { listInstallations } = require("../controllers/installationsController");

router.get("/", protect, listInstallations);

module.exports = router;
