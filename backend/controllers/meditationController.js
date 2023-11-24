const asyncHanlder = require('express-async-handler')

const getMeditations = asyncHanlder(async(req, res) => {
    res.status(200).json({message: 'get meditation'})
})

const createMeditation = asyncHanlder(async(req, res) => {
    if(!req.body.text){
        res.status(400)
        throw new Error("please add a text field")
    }
    res.status(200).json({message: 'posted meditation'})
})

const editMeditation = asyncHanlder(async(req, res) => {
    res.status(200).json({message: `you just edit meditation with the id: ${req.params.id}`})
})

const deleteMeditation = asyncHanlder(async(req, res) => {
    res.status(200).json({message: `you just delete meditation with the id: ${req.params.id}`})
})

module.exports = {
    getMeditations,
    createMeditation,
    editMeditation,
    deleteMeditation
}