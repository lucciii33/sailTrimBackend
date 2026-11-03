const express = require('express');
const router = express.Router()
const {registerUser, loginUser, googleLogin, resetLoginDays, resetPassword, forgotPassword, saveAnthropicKey, deleteAnthropicKey, getMySettings} = require('../controllers/userController')
const {
  setupTwoFactor,
  verifyTwoFactorSetup,
  disableTwoFactor,
  loginVerifyTwoFactor,
} = require('../controllers/twoFactorController')
const { protect } = require('../middleware/authMiddleware');
const {
  authLimiter,
  passwordResetLimiter,
  twoFactorLimiter,
} = require('../middleware/rateLimiters');

router.route('/').post(authLimiter, registerUser)
router.route('/register').post(authLimiter, registerUser)
router.route('/login').post(authLimiter, loginUser)
router.route('/auth/google').post(authLimiter, googleLogin)
router.route('/login/2fa').post(twoFactorLimiter, loginVerifyTwoFactor)
router.route('/reset-password/:token').put(passwordResetLimiter, resetPassword)
router.route('/forgot-password').post(passwordResetLimiter, forgotPassword)
// router.route('/prueba-reset').post(resetLoginDays)

router.get('/me/settings', protect, getMySettings)
router.put('/me/anthropic-key', protect, saveAnthropicKey)
router.delete('/me/anthropic-key', protect, deleteAnthropicKey)

router.post('/me/2fa/setup', protect, twoFactorLimiter, setupTwoFactor)
router.post('/me/2fa/verify', protect, twoFactorLimiter, verifyTwoFactorSetup)
router.post('/me/2fa/disable', protect, twoFactorLimiter, disableTwoFactor)


module.exports = router
