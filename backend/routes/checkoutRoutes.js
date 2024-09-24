const express = require('express');
const router = express.Router()
const {payment, checkpayment, cancelSuscription} = require('../controllers/checkoutController') 
const { protect } = require('../middleware/authMiddleware')

router.route('/pay').post(payment)
router.route('/check/:userId').get(checkpayment)
router.route('/cancel/:userId').post(cancelSuscription)

module.exports = router