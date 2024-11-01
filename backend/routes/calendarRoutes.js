const express = require("express");
const router = express.Router();
const {
  getSessionsByUserId,
  sessionById,
  createSession,
  deleteSession,
  editSession,
} = require("../controllers/calendarController");
const { protect } = require("../middleware/authMiddleware");

router.route("/getSessionsByUserId/:userId").get(protect, getSessionsByUserId);
router.route("/sessionById/:sessionId").get(protect, sessionById);
router.route("/createSession").post(protect, createSession);
router.route("/editSession/:id").put(protect, editSession);
router.route("/deleteSession/:id").delete(protect, deleteSession);

module.exports = router;
