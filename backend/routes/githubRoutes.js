const express = require("express");
const router = express.Router();
const {
  githubCallback,
  startBackfill,
  getBackfillJob,
} = require("../controllers/githubController");

router.get("/callback", githubCallback);
router.post("/docs/backfill", startBackfill);
router.get("/docs/backfill/:jobId", getBackfillJob);

module.exports = router;
