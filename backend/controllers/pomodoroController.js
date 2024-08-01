const asyncHanlder = require('express-async-handler')
const Task = require('../model/taskModel')
const Pomodoro =  require('../model/pomodoroModel')
const User = require('../model/userModel')

const getTasks = asyncHanlder(async(req, res) => {
    const tasks = await Task.find();
    res.json(tasks);
})

const getTasksById = asyncHanlder(async(req, res) => {
    const taskId = req.params.id; // Obtén el ID de la tarea desde los parámetros de la URL
    
    // Implementa la lógica para buscar la tarea por su ID
    const task = await Task.findById(taskId);
    
    if (!task) {
        res.status(404);
        throw new Error('Task not found');
    }
    
    res.json(task);
})

const getTasksByUserId = asyncHanlder(async(req, res) => {
    const userId = req.params.userId; // Obtén el ID del usuario desde los parámetros de la URL
    
    const tasks = await Task.find({ UserId: userId });

    res.json(tasks);
})

const createTask = asyncHanlder(async(req, res) => {
    const {
        taskName,
        description,
        completed,
        UserId
      } = req.body;
    
      console.log("POMODORO CREATE", req.body);

      if (!description || !taskName) {
        res.status(400);
        throw new Error("Please add all required fields");
      }
    
      const newTask = await Task.create({
        taskName,
        description,
        completed,
        UserId
      });
    
      if (newTask) {
        res.status(201).json({
          description: newTask.description,
          taskName: newTask.taskName,
          completed: newTask.completed,
          UserId: newTask.UserId
        });
      } else {
        res.status(400);
        throw new Error("Meditation wasn't registered correctly");
      }
})

const editTask = asyncHanlder(async(req, res) => {
    const updatedTask = await Task.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
    });

    if (!updatedTask) {
        res.status(404);
        throw new Error("WhitenNose not found");
    }

    res.status(200).json(updatedTask);
})


const deleteTask = asyncHanlder(async(req, res) => {
    const deleteTask = await Task.findByIdAndDelete(req.params.id);

    if (!deleteTask) {
        res.status(404);
        throw new Error("task not found");
    }

    res.status(200).json({ message: `task with id ${req.params.id} deleted successfully` });
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
    getTasksByUserId,
    getTasks,
    getTasksById,
    createTask,
    editTask,
    deleteTask,
    getPomodoros,
    createPomodoro,
    editPmodoro,
    deletePomodoro
}