const asyncHanlder = require("express-async-handler");
const Calendar = require("../model/calendarModel");

const getSessionsByUserId = asyncHanlder(async (req, res) => {
  const sessionesDelUsuario = await Calendar.find({
    userId: req.params.userId,
  });

  if (!sessionesDelUsuario) {
    res.status(404);
    throw new Error("No se encontraron notas para este usuario");
  }

  res.json(sessionesDelUsuario);
});

const sessionById = asyncHanlder(async (req, res) => {
  console.log("req", req.params);
  const sessionId = req.params.sessionId; // Obtén el ID de la tarea desde los parámetros de la URL

  // Implementa la lógica para buscar la tarea por su ID
  const resume = await Calendar.findById(sessionId);

  if (!resume) {
    res.status(404);
    throw new Error("Apunte sin encontrar");
  }

  res.json(resume);
});

const createSession = asyncHanlder(async (req, res) => {
  const { sessionName, description, completed, date, time, userId } = req.body;

  console.log(req.body);

  if (!sessionName || !date || !time || !userId) {
    res.status(400);
    throw new Error("Please add all required fields");
  }

  const session = await Calendar.create({
    sessionName,
    description,
    completed,
    date,
    time,
    userId,
  });

  if (session) {
    res.status(201).json({
      _id: session.id,
      sessionName: session.sessionName,
      description: session.description,
      completed: session.completed,
      date: session.date,
      time: session.time,
      userId: session.userId,
    });
  } else {
    res.status(400);
    throw new Error("Meditation wasn't registered correctly");
  }
});

const editSession = asyncHanlder(async (req, res) => {
  const updatedSession = await Calendar.findByIdAndUpdate(
    req.params.id,
    req.body,
    {
      new: true,
    }
  );

  if (!updatedSession) {
    res.status(404);
    throw new Error("estos Apuntes no se encuentran");
  }

  res.status(200).json(updatedSession);
});

const deleteSession = asyncHanlder(async (req, res) => {
  const deletedSession = await Calendar.findByIdAndDelete(req.params.id);

  if (!deletedSession) {
    res.status(404);
    throw new Error("estos Apuntes no se encuentran");
  }

  res.status(200).json({
    message: `Apuntes con el id ${req.params.id} deleted successfully`,
  });
});

module.exports = {
  getSessionsByUserId,
  sessionById,
  createSession,
  deleteSession,
  editSession,
};
