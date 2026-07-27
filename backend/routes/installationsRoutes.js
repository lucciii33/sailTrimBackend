const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  listInstallations,
  disconnectInstallation,
} = require("../controllers/installationsController");

router.get("/", protect, listInstallations);
router.delete("/:installationId", protect, disconnectInstallation);

module.exports = router;
