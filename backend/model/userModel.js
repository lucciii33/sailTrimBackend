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
        required: false
    },
    pais: {
        type: String,
        required: false
    },
    role: {
        type: String,
        required: true
    },
    loginDays: { 
        type: Map,
        of: Boolean,
        default: {
          "0": false, // Sunday
          "1": false, // Monday
          "2": false, // Tuesday
          "3": false, // Wednesday
          "4": false, // Thursday
          "5": false, // Friday
          "6": false  // Saturday
        }
    },
    lastWeekNumber: {
        type: Number,
        default: Math.floor(Date.now() / (1000 * 60 * 60 * 24 * 7))
    },
    customerId:{
        type: String,
        required: false
    },
    tasks: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Task"
    }],
    terms:{
        type: Boolean,
        required: false
    },
    resetPasswordToken:{
        type: String,
        required: false
    },
    resetPasswordExpire:{
        type: Date,
        required: false
    } 
}, {
    timestamps: true
});

module.exports = mongoose.model('User', userSchema);