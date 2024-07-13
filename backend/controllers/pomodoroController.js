const asyncHanlder = require('express-async-handler')
const Task = require('../model/taskModel')
const Pomodoro =  require('../model/pomodoroModel')

const getTasks = asyncHanlder(async(req, res) => {
    
})

const createTask = asyncHanlder(async(req, res) => {
   
})

const editTask = asyncHanlder(async(req, res) => {

})

const deleteTask = asyncHanlder(async(req, res) => {
  
})

/////Pomodoro functions here: 
const getPomodoros = asyncHanlder(async(req, res) => {
    const pomodoros = await Pomodoro.find();
    res.json(pomodoros);
})

const createPomodoro = asyncHanlder(async(req, res) => {
    try {
        const {workDuration, breakDuration } = req.body;
        console.log("bodybody", req.body)

        // Validate input
        if (!workDuration || !breakDuration) {
            return res.status(400).json({ message: 'workDuration, and breakDuration are required' });
        }

        // Create new Pomodoro session
        const pomodoro = new Pomodoro({
            workDuration: workDuration,
            breakDuration: breakDuration
        });

        // Save Pomodoro session to database
        await pomodoro.save();

        // Return success response
        res.status(201).json({ message: 'Pomodoro session started successfully', pomodoro });
    } catch (error) {
        // Handle error
        res.status(500).json({ message: error.message });
    }
})

const editPmodoro = asyncHanlder(async(req, res) => {

})

const deletePomodoro = asyncHanlder(async(req, res) => {
  
})

module.exports = {
    getTasks,
    createTask,
    editTask,
    deleteTask,
    getPomodoros,
    createPomodoro,
    editPmodoro,
    deletePomodoro
}