const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const c = require("../controllers/mcpWatcherController");

// MCP watchers: a merge into the watched branch of the repo an MCP server is
// built from -> wait for the deploy -> re-read the live server's tools ->
// flag the new ones -> generate suites and bug-hunt them.
//
// Literal paths first so "/runs" and "/new-tools" are never read as an :id.
router.get("/runs/all", protect, c.listMcpRuns);
router.get("/new-tools/all", protect, c.listNewTools);
router.post("/new-tools/acknowledge", protect, c.acknowledgeNewTools);

router.get("/", protect, c.listMcpWatchers);
router.post("/", protect, c.createMcpWatcher);
router.put("/:id", protect, c.updateMcpWatcher);
router.delete("/:id", protect, c.deleteMcpWatcher);
router.get("/:id/runs", protect, c.listMcpRuns);

module.exports = router;
