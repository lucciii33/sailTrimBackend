const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const c = require("../controllers/companyController");

// Public: read invite metadata before signup/login
router.get("/invite/:token", c.getInvite);

// Authenticated
router.get("/", protect, c.getMyCompany);
router.get("/members", protect, c.listMembers);
router.post("/invite", protect, c.inviteMember);
router.post("/accept", protect, c.acceptInvite);
router.delete("/members/:userId", protect, c.removeMember);
router.delete("/invite/:id", protect, c.cancelInvite);

router.get("/slack", protect, c.getSlackConfig);
router.put("/slack", protect, c.saveSlackConfig);
router.delete("/slack", protect, c.deleteSlackConfig);

module.exports = router;
