const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const c = require("../controllers/watcherController");

// Watchers: standing watches on a connected repo. A merge into the watched
// branch regenerates that repo's docs, flags endpoints that weren't there
// before, and generates QA for them.
router.get("/", protect, c.listWatchers);
router.post("/", protect, c.createWatcher);
router.put("/:id", protect, c.updateWatcher);
router.delete("/:id", protect, c.deleteWatcher);
router.post("/:id/run", protect, c.runWatcherNow);

// Run history — the "which endpoints appeared, and when" record.
router.get("/runs/all", protect, c.listRuns);
router.get("/:id/runs", protect, c.listRuns);

// Endpoints flagged as new, and clearing that flag once reviewed.
router.get("/new-endpoints/all", protect, c.listNewEndpoints);
router.post("/new-endpoints/acknowledge", protect, c.acknowledgeNewEndpoints);

module.exports = router;
