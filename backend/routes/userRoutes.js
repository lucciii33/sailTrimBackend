const express = require('express');
const router = express.Router()
const {registerUser, loginUser, resetLoginDays, resetPassword, forgotPassword, saveAnthropicKey, deleteAnthropicKey, getMySettings} = require('../controllers/userController')
const { protect } = require('../middleware/authMiddleware');

router.route('/').post(registerUser)
router.route('/register').post(registerUser)
router.route('/login').post(loginUser)
router.route('/reset-password/:token').put(resetPassword)
router.route('/forgot-password').post(forgotPassword)
// router.route('/prueba-reset').post(resetLoginDays)

router.get('/me/settings', protect, getMySettings)
router.put('/me/anthropic-key', protect, saveAnthropicKey)
router.delete('/me/anthropic-key', protect, deleteAnthropicKey)


module.exports = router
