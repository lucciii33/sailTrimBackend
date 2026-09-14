const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  listInstallations,
  syncInstallations,
  disconnectInstallation,
  removeRepo,
} = require("../controllers/installationsController");

router.get("/", protect, listInstallations);
// Re-read the repo list from GitHub for every install the user can see — the
// escape hatch when a webhook never arrived and the list went stale.
router.post("/sync", protect, syncInstallations);
// Remove ONE repo from Olivia (GitHub access + all its data), keeping the
// connection and the other repos. Declared before the bare :installationId
// route for readability; the extra segments keep them from colliding anyway.
router.delete("/:installationId/repos/:repo", protect, removeRepo);
router.delete("/:installationId", protect, disconnectInstallation);

module.exports = router;
