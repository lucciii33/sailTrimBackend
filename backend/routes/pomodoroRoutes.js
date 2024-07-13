const express = require('express')
const router = express.Router()
const {createPomodoro, getPomodoros} = require('../controllers/pomodoroController')

router.get('/',  getPomodoros)
router.post('/', createPomodoro)

module.exports = router