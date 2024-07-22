const express = require('express');
const router = express.Router()
const {generateTextGoole, generateTestQuestions, gradeExam, generateflashCards, generateText} = require('../controllers/dashboardController') 
const { protect } = require('../middleware/authMiddleware')

router.route('/exp').post(protect, generateTextGoole)
router.route('/test').post(protect, generateTestQuestions)
router.route('/grade').post(protect, gradeExam)
router.route('/flashCards').post(protect, generateText)

module.exports = router