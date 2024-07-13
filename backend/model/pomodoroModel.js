const mongoose = require('mongoose');

const pomodoroSchema = mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: false,
        ref: "User"
    },
    workDuration: {
        type: Number,
        required: true
    },
    breakDuration: {
        type: Number,
        required: true
    },
    tasks: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Task"
    }],
    
}, {
    timestamps: true
});

module.exports = mongoose.model('Pomodoro', pomodoroSchema);