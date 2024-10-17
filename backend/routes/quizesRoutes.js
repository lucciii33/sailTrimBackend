const express = require('express');
const router = express.Router()
const { deleteQuizes,
    createQuizes,
    getQuizesById,
    getQuizesUserId } = require('../controllers/quizezController')
const { protect } = require('../middleware/authMiddleware')

router.route('/createQuizes').post(protect, createQuizes)
router.route('/getQuizesById/:id').get(protect, getQuizesById)
router.route('/getQuizesUserId/:userId').get(protect, getQuizesUserId)
router.route('/deleteQuizes/:examId').delete(protect, deleteQuizes)

module.exports = router
