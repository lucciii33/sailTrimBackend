const express = require('express');
const router = express.Router()
const { getMotivationalNotes, createMotivationalNotes, editMotivationalNotes, deleteMotivationalNotes, getRandomMotivationalNote} = require('../controllers/noteController') 

router.route('/').post(createMotivationalNotes)
router.route('/').get(getMotivationalNotes)
router.route('/random').get(getRandomMotivationalNote)
module.exports = router