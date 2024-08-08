const mongoose = require('mongoose');

const resumeSchema = mongoose.Schema({
    resume: {
        type: String,
        required: false
    },
    UserId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        ref: "User"
    },
}, {
    timestamps: true
});

module.exports = mongoose.model('Resume', resumeSchema);