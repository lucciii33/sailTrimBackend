const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getAudiosByUserId,
  createText,
  deleteAudioByUserId,
  editAudiosByUserId,
} = require("../controllers/audioToTextController");

router.route("/getAudiosByUserId/:userId").get(protect, getAudiosByUserId);
router.route("/createText").post(protect, createText);
router.route("/editAudiosByUserId/:audioId").put(protect, editAudiosByUserId);
router
  .route("/deleteAudioByUserId/:audioId")
  .delete(protect, deleteAudioByUserId);

module.exports = router;
