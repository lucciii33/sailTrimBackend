const mongoose = require('mongoose');

const notesSchema = mongoose.Schema({
    motivationalNote: {
        type: String,
        required: true
    },
    by: {
        type: String,
        required: false
    },
}, {
    timestamps: true
});

module.exports = mongoose.model('Notes', notesSchema);