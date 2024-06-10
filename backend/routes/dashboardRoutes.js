const express = require('express');
const router = express.Router()
const {generateText} = require('../controllers/dashboardController') 

router.route('/exp').post(generateText)

module.exports = router