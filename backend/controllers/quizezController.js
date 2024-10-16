const asyncHanlder = require('express-async-handler')
const GradedExam = require('../model/quizezModel')

const getQuizesUserId = asyncHanlder(async(req, res) => {
    const userId = req.params.userId;
    const exams = await GradedExam.find({ userId });

    if (!exams) {
        res.status(404);
        throw new Error('No se encontraron exámenes para este usuario');
    }

    res.json(exams);
})

const getQuizesById = asyncHanlder(async(req, res) => {
    const examId = req.params.id;
    const exam = await GradedExam.findById(examId);

    if (!exam) {
        res.status(404);
        throw new Error('Examen no encontrado');
    }

    res.json(exam);
})

const createQuizes = asyncHanlder(async(req, res) => {
    const { gradedExam, userId, title } = req.body; // Asegúrate de enviar el `gradedExam` en el cuerpo del request

    if (!gradedExam || !userId || !title) {
        res.status(400);
        throw new Error('Por favor provee el examen evaluado y el userId y el titulo');
    }

    const newExam = new GradedExam({ gradedExam, userId, title });
    const savedExam = await newExam.save();

    res.status(201).json(savedExam);
})

const deleteQuizes = asyncHanlder(async(req, res) => {
    const examId = req.params.examId;
    const deletedExam = await GradedExam.findByIdAndDelete(examId);

    if (!deletedExam) {
        res.status(404);
        throw new Error('Examen no encontrado');
    }

    res.json({ message: 'Examen eliminado exitosamente' });
})

module.exports = {
    deleteQuizes,
    createQuizes,
    getQuizesById,
    getQuizesUserId
}