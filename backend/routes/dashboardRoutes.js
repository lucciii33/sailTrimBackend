const express = require("express");
const router = express.Router();

const {
  generateTextGoole,
  generateTestQuestions,
  gradeExam,
  generateflashCards,
  generateText,
  generateFeynman,
  imagesStory,
  generateWordsCombination,
  generateHomework,
  generateMaps,
  audioToText,
  textToAudio,
  generateflashCardsV2,
} = require("../controllers/dashboardController");
const { protect } = require("../middleware/authMiddleware");
const multer = require("multer");
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.route("/exp").post(protect, generateTextGoole);
router.route("/test").post(protect, generateTestQuestions);
router.route("/grade").post(protect, gradeExam);
router.route("/generateFeynman").post(protect, generateFeynman);
router.route("/flashCards").post(protect, generateText);
router.route("/imagesStory").post(protect, imagesStory);
router
  .route("/generateWordsCombination")
  .post(protect, generateWordsCombination);
router.route("/generateHomework").post(protect, generateHomework);
router.route("/generateMaps").post(protect, generateMaps);
router.route("/textToAudio").post(protect, textToAudio);
router.route("/audioToText").post(protect, upload.single("file"), audioToText);
router.route("/generateflashCardsV2").post(protect, generateflashCardsV2);

module.exports = router;
