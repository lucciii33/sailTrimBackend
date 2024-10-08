const asyncHanlder = require('express-async-handler')
const Apuntes = require('../model/apuntesModel')

const getSheetNotesByUserId = asyncHanlder(async(req, res) => {
    const notesDelUsuario = await Apuntes.find({ userId: req.params.userId });

    if (!notesDelUsuario) {
        res.status(404);
        throw new Error("No se encontraron notas para este usuario");
    }

    res.json(notesDelUsuario);
})

const getApuntesById = asyncHanlder(async(req, res) => {
  console.log("req", req.params)
  const resumeId = req.params.apunteId; // Obtén el ID de la tarea desde los parámetros de la URL
  
  // Implementa la lógica para buscar la tarea por su ID
  const resume = await Apuntes.findById(resumeId);
  
  if (!resume) {
      res.status(404);
      throw new Error('Apunte sin encontrar');
  }
  
  res.json(resume);
})

const createSheetNotes = asyncHanlder(async(req, res) => {
    const {
        preguntas, argumentos, conclusiones, evidencias, name, date, userId, titulo
      } = req.body;
    
      console.log(req.body);

    
      if (!titulo|| !preguntas || !argumentos || !conclusiones || !evidencias || !userId ) {
        res.status(400);
        throw new Error("Please add all required fields");
      }
    
      const nuevosApuntes = await Apuntes.create({
        preguntas, titulo, argumentos, conclusiones, evidencias, userId
      });
    
      if (nuevosApuntes) {
        res.status(201).json({
          _id: nuevosApuntes.id,
          preguntas: nuevosApuntes.preguntas,
          conclusiones: nuevosApuntes.conclusiones,
          argumentos: nuevosApuntes.argumentos,
          evidencias: nuevosApuntes.evidencias,
          titulo: nuevosApuntes.titulo,
          userId: nuevosApuntes.userId
        });
      } else {
        res.status(400);
        throw new Error("Meditation wasn't registered correctly");
      }
})

const editSheetNotes = asyncHanlder(async(req, res) => {
  const updatedApuntes = await Apuntes.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
});

if (!updatedApuntes) {
    res.status(404);
    throw new Error("estos Apuntes no se encuentran");
}

res.status(200).json(updatedApuntes);
})

const deleteSheetNotes = asyncHanlder(async(req, res) => {
  const deletedApuntes = await Apuntes.findByIdAndDelete(req.params.id);

  if (!deletedApuntes) {
      res.status(404);
      throw new Error("estos Apuntes no se encuentran");
  }

  res.status(200).json({ message: `Apuntes con el id ${req.params.id} deleted successfully` });
})



module.exports = {
  getSheetNotesByUserId,
  createSheetNotes,
  editSheetNotes,
  deleteSheetNotes,
  getApuntesById
}