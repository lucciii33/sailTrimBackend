const mongoose = require('mongoose')

const ApuntesSchema = mongoose.Schema({

    description: {
        type: String,
        required: false
    },
    preguntas: {
        type: [{
            pregunta: String,
            respuesta: String,
            estado: Boolean // Por ejemplo, si está resuelta o no
        }],
        required: false
    },
    argumentos: {
        type: String,
        required: false
    },
    conclusiones:{
        type: String,
        required: false
    },
    evidencias: {
        type: String,
        required: false
    },
    name: {
        type: String,
        required: false
    },
    date: {
        type: Date,
        required: false
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: false,
        ref: "User"
    },
},{
    timestamps: true
})

module.exports = mongoose.model('Apuntes', ApuntesSchema)