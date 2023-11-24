const express = require('express')
const router = express.Router()
const {getMeditations, createMeditation, editMeditation, deleteMeditation} = require('../controllers/meditationController')



router.get('/',  getMeditations)
router.post('/', createMeditation)
router.put('/:id', editMeditation)
router.delete('/:id',deleteMeditation)

module.exports = router