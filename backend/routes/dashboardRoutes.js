const express = require('express');
const router = express.Router()
const {generateTextGoole, generateTestQuestions, gradeExam, generateflashCards, generateText} = require('../controllers/dashboardController') 

router.route('/exp').post(generateTextGoole)
router.route('/test').post(generateTestQuestions)
router.route('/grade').post(gradeExam)
router.route('/flashCards').post(generateText)

module.exports = router