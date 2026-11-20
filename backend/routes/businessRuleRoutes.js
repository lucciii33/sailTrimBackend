const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const c = require("../controllers/businessRuleController");

// The business rules Olivia keeps per API, reviewed by the team.
router.get("/", protect, c.listRules);
router.get("/export.md", protect, c.exportRules);
router.post("/", protect, c.createRule);
router.patch("/:id", protect, c.updateRule);
router.delete("/:id", protect, c.deleteRule);

module.exports = router;
