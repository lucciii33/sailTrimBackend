const express = require('express');
const router = express.Router()
const {registerUser, loginUser, resetLoginDays, resetPassword, forgotPassword} = require('../controllers/userController') 

router.route('/register').post(registerUser)
router.route('/login').post(loginUser)
router.route('/reset-password/:token').put(resetPassword)
router.route('/forgot-password').post(forgotPassword)
// router.route('/prueba-reset').post(resetLoginDays)




module.exports = router