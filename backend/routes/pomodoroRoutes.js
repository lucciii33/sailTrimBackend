const express = require('express')
const router = express.Router()
const {createPomodoro, getPomodoros, getTasks, createTask, getTasksById, getTasksByUserId, deleteTask} = require('../controllers/pomodoroController')
const { protect } = require('../middleware/authMiddleware')

router.get('/', protect, getPomodoros)
router.post('/',protect, createPomodoro)

router.get('/tasks', protect,   getTasks)
router.get('/userTask/:userId', protect,  getTasksByUserId)
router.get('/getTasksById/:id', protect, getTasksById )
router.post('/createTask', protect, createTask)
router.delete('/deleteTask/:id', protect, deleteTask)


module.exports = router