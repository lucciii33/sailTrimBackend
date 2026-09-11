const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  listInstallations,
  syncInstallations,
  disconnectInstallation,
} = require("../controllers/installationsController");

router.get("/", protect, listInstallations);
// Re-read the repo list from GitHub for every install the user can see — the
// escape hatch when a webhook never arrived and the list went stale.
router.post("/sync", protect, syncInstallations);
router.delete("/:installationId", protect, disconnectInstallation);

module.exports = router;
