const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  githubCallback,
  getConnectLink,
  startBackfill,
  getBackfillJob,
} = require("../controllers/githubController");

router.get("/connect-link", protect, getConnectLink);
// /callback stays public: it's a plain browser redirect from GitHub, no
// bearer token available to send.
router.get("/callback", githubCallback);
router.post("/docs/backfill", protect, startBackfill);
router.get("/docs/backfill/:jobId", protect, getBackfillJob);

module.exports = router;
