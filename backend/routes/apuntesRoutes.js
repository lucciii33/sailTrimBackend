const express = require("express");
const router = express.Router();
const {
  getSheetNotesByUserId,
  createSheetNotes,
  editSheetNotes,
  deleteSheetNotes,
} = require("../controllers/apuntesController");
const { protect } = require("../middleware/authMiddleware");

router.route("/getSheetNotesByUserId/:userId").get(protect, getSheetNotesByUserId);
router.route("/createSheetNotes").post(protect, createSheetNotes);
router.route("/editSheetNotes/:id").put(protect, editSheetNotes);
router.route("/deleteSheetNotes/:id").delete(protect, deleteSheetNotes);


module.exports = router;
