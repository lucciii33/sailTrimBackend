const express = require('express');
const router = express.Router()
const {payment, checkpayment} = require('../controllers/checkoutController') 

router.route('/pay').post(payment)
router.route('/check/:customerId').get(checkpayment)

module.exports = router