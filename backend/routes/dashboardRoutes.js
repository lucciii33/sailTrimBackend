const express = require('express');
const router = express.Router()
const {generateTextGoole, generateTestQuestions, gradeExam} = require('../controllers/dashboardController') 

router.route('/exp').post(generateTextGoole)
router.route('/test').post(generateTestQuestions)
router.route('/grade').post(gradeExam)

module.exports = router