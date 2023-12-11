const express = require('express')
const router = express.Router()
const { getWhitenNose,
    createWhitenNose,
    editWhitenNose,
    deleteWhitenNose} = require('../controllers/WhiteNoiseController')
const multer = require('multer');


const storage = multer.memoryStorage(); // Store files in memory as Buffer
const upload = multer({ storage: storage });



router.get('/',  getWhitenNose)
router.post('/', upload.single('audio'), createWhitenNose)
router.put('/:id', editWhitenNose)
router.delete('/:id',deleteWhitenNose)

module.exports = router