const asyncHanlder = require('express-async-handler')
const Resume = require('../model/resumeModel')
const Pomodoro =  require('../model/pomodoroModel')
const User = require('../model/userModel')

const getResumes = asyncHanlder(async(req, res) => {
    const resume = await Resume.find();
    res.json(resume);
})

const getResumeById = asyncHanlder(async(req, res) => {
    const resumeId = req.params.id; // Obtén el ID de la tarea desde los parámetros de la URL
    
    // Implementa la lógica para buscar la tarea por su ID
    const resume = await Resume.findById(resumeId);
    
    if (!resume) {
        res.status(404);
        throw new Error('Task not found');
    }
    
    res.json(resume);
})

const getResumesByUserId = asyncHanlder(async(req, res) => {
    const userId = req.params.userId; // Obtén el ID del usuario desde los parámetros de la URL
    
    const resumes = await Resume.find({ UserId: userId });

    res.json(resumes);
})

const createResume = asyncHanlder(async(req, res) => {
    const {
        resume,
        UserId
      } = req.body;
    

      if (!resume) {
        res.status(400);
        throw new Error("Please add all required fields");
      }
    
      const newResume = await Resume.create({
        resume,
        UserId

      });
    
      if (newResume) {
        res.status(201).json({
            resume: newResume.resume,
            UserId: newResume.UserId
        });
      } else {
        res.status(400);
        throw new Error("Meditation wasn't registered correctly");
      }
})

const editResume = asyncHanlder(async(req, res) => {
    const updatedResume = await Resume.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
    });

    if (!updatedResume) {
        res.status(404);
        throw new Error("WhitenNose not found");
    }

    res.status(200).json(updatedResume);
})


const deleteResume = asyncHanlder(async(req, res) => {
    const deleteResume = await Resume.findByIdAndDelete(req.params.id);

    if (!deleteResume) {
        res.status(404);
        throw new Error("task not found");
    }

    res.status(200).json({ message: `resume with id ${req.params.id} deleted successfully` });
})


module.exports = {
    getResumes,
    getResumeById,
    getResumesByUserId,
    createResume,
    editResume,
    deleteResume
}