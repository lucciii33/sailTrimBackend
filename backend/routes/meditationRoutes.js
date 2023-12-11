const express = require('express')
const router = express.Router()
const {getMeditations, createMeditation, editMeditation, deleteMeditation} = require('../controllers/meditationController')
const multer = require('multer');


const storage = multer.memoryStorage(); // Store files in memory as Buffer
const upload = multer({ storage: storage });



router.get('/',  getMeditations)
router.post('/', upload.single('audio'), createMeditation)
router.put('/:id', editMeditation)
router.delete('/:id',deleteMeditation)

module.exports = router