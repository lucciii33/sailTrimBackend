const express = require('express');
const router = express.Router()
const { getMotivationalNotes, createMotivationalNotes, editMotivationalNotes, deleteMotivationalNotes, getRandomMotivationalNote} = require('../controllers/noteController') 
const { protect } = require('../middleware/authMiddleware')

router.route('/').post(protect, createMotivationalNotes)
router.route('/').get(protect, getMotivationalNotes)
router.route('/random').get(protect, getRandomMotivationalNote)
module.exports = router