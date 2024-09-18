const express = require('express');
const router = express.Router()
const {generateTextGoole, generateTestQuestions, gradeExam, generateflashCards, generateText, generateFeynman, imagesStory, generateWordsCombination, generateHomework} = require('../controllers/dashboardController') 
const { protect } = require('../middleware/authMiddleware')

router.route('/exp').post(protect, generateTextGoole)
router.route('/test').post(protect, generateTestQuestions)
router.route('/grade').post(protect, gradeExam)
router.route('/generateFeynman').post(protect, generateFeynman)
router.route('/flashCards').post(protect, generateText)
router.route('/imagesStory').post(protect, imagesStory)
router.route('/generateWordsCombination').post(protect, generateWordsCombination)
router.route('/generateHomework').post(protect, generateHomework)


module.exports = router