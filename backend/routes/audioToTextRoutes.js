const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getAudiosByUserId,
  createText,
  deleteAudioByUserId,
  editAudiosByUserId,
  getAudioToTextById,
} = require("../controllers/audioToTextController");

router.route("/getAudiosByUserId/:userId").get(protect, getAudiosByUserId);
router.route("/getAudioToTextById/:audioId").get(protect, getAudioToTextById);
router.route("/createText").post(protect, createText);
router.route("/editAudiosByUserId/:audioId").put(protect, editAudiosByUserId);
router
  .route("/deleteAudioByUserId/:audioId")
  .delete(protect, deleteAudioByUserId);

module.exports = router;
