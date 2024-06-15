const express = require('express');
const router = express.Router()
const {generateTextGoole, generateTestQuestions} = require('../controllers/dashboardController') 

router.route('/exp').post(generateTextGoole)
router.route('/test').post(generateTestQuestions)

module.exports = router