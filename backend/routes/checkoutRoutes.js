const express = require('express');
const router = express.Router()
const {payment, checkpayment} = require('../controllers/checkoutController') 
const { protect } = require('../middleware/authMiddleware')


router.route('/pay').post( payment)
router.route('/check/:userId').get(checkpayment)

module.exports = router