const asyncHanlder = require('express-async-handler')
const MotivationalNotes = require('../model/notesModel')

const getMotivationalNotes = asyncHanlder(async(req, res) => {
    const motivationalNotes = await MotivationalNotes.find();
    res.json(motivationalNotes);
})

const createMotivationalNotes = asyncHanlder(async(req, res) => {
    const {
      motivationalNote,
      by
      } = req.body;
    
      console.log(req.body);

    
      if (!motivationalNote) {
        res.status(400);
        throw new Error("Please add all required fields");
      }
    
      const newMotivationalNote = await MotivationalNotes.create({
        motivationalNote,
        by,
      });
    
      if (newMotivationalNote) {
        res.status(201).json({
          _id: newMotivationalNote.id,
          motivationalNote: newMotivationalNote.motivationalNote,
          by: newMotivationalNote.by,
        });
      } else {
        res.status(400);
        throw new Error("Meditation wasn't registered correctly");
      }
})

const editMotivationalNotes = asyncHanlder(async(req, res) => {
  const updatedMotivationalNote = await MotivationalNotes.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
});

if (!updatedMotivationalNote) {
    res.status(404);
    throw new Error("WhitenNose not found");
}

res.status(200).json(updatedMotivationalNote);
})

const deleteMotivationalNotes = asyncHanlder(async(req, res) => {
  const deletedMotivationalNote = await MotivationalNotes.findByIdAndDelete(req.params.id);

  if (!deletedMotivationalNote) {
      res.status(404);
      throw new Error("deletedMeditation not found");
  }

  res.status(200).json({ message: `deletedMeditation with id ${req.params.id} deleted successfully` });
})

const getRandomMotivationalNote = asyncHanlder(async (req, res) => {
  const [randomMotivationalNote] = await MotivationalNotes.aggregate([{ $sample: { size: 1 } }]);

  if (!randomMotivationalNote) {
      res.status(404);
      throw new Error("No motivational notes found");
  }

  res.status(200).json(randomMotivationalNote);
})


module.exports = {
  getMotivationalNotes,
  createMotivationalNotes,
  editMotivationalNotes,
  deleteMotivationalNotes,
  getRandomMotivationalNote
}