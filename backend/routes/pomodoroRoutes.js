const express = require('express')
const router = express.Router()
const {createPomodoro, getPomodoros, getTasks, createTask, getTasksById, getTasksByUserId} = require('../controllers/pomodoroController')

router.get('/',  getPomodoros)
router.post('/', createPomodoro)

router.get('/tasks',  getTasks)
router.get('/userTask/:userId',  getTasksByUserId)
router.get('/getTasksById/:id', getTasksById )
router.post('/createTask', createTask)

module.exports = router