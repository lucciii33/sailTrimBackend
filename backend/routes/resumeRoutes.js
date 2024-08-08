const express = require('express')
const router = express.Router()
const {getResumes, getResumeById, getResumesByUserId, createResume, editResume,deleteResume} = require('../controllers/resumeController')
const { protect } = require('../middleware/authMiddleware')

router.get('/', protect, getResumes)
router.post('/',protect, createResume)

router.get('/userResumes/:userId', protect,  getResumesByUserId)
router.get('/getResumeById/:id', protect, getResumeById )
router.put('/editResume/:id', protect, editResume)
router.delete('/deleteResume/:id', protect, deleteResume)


module.exports = router