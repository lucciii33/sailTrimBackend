const mongoose = require('mongoose')

const MeditationSchema = mongoose.Schema({

    description: {
        type: String,
        required: true
    },
    audio: {
        type: Buffer,
        required: true
    },
    duration:{
        type: String,
        required: true
    },
    image: {
        type: String,
        required: true
    },
    name: {
        type: String,
        required: true
    },
    category: {
        type: String,
        required: true
    }
},{
    timestamps: true
})

module.exports = mongoose.model('Meditation', MeditationSchema)