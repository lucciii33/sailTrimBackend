const express = require('express');
const router = express.Router()
const {generateTextGoole} = require('../controllers/dashboardController') 

router.route('/exp').post(generateTextGoole)

module.exports = router