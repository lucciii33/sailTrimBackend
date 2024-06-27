const mongoose = require('mongoose');

const userSchema = mongoose.Schema({
    firstName: {
        type: String,
        required: true
    },
    lastName: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true
    },
    password: {
        type: String,
        required: true
    },
    edad: {
        type: Number,
        required: true
    },
    pais: {
        type: String,
        required: false
    },
    role: {
        type: String,
        required: true
    },
}, {
    timestamps: true
});

module.exports = mongoose.model('User', userSchema);