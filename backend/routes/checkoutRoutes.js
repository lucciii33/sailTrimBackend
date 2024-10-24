const express = require('express');
const router = express.Router()
const {payment, checkpayment, cancelSuscription, updatePaymentMethod, createNewSecretKey} = require('../controllers/checkoutController') 
const { protect } = require('../middleware/authMiddleware')

router.route('/pay').post(payment)
router.route('/check/:userId').get(checkpayment)
router.route('/cancel/:userId').post(cancelSuscription)
router.route('/updatePaymentMethod').put(updatePaymentMethod)
router.route('/createNewSecretKey').post(protect, createNewSecretKey)

module.exports = router