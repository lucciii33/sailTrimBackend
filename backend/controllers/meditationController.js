const asyncHanlder = require('express-async-handler')
const Meditation = require('../model/meditationModel')

const getMeditations = asyncHanlder(async(req, res) => {
    const meditations = await Meditation.find();
    res.json(meditations);
})

const createMeditation = asyncHanlder(async(req, res) => {
    const {
        description,
        duration,
        image,
        name,
        category
      } = req.body;
    
      console.log(req.body);

      const audioBuffer = req.file.buffer;

      if (!req.file || !req.file.buffer) {
        res.status(400);
        throw new Error("Audio file is missing");
      }
    
      if (!description || !duration  || !audioBuffer || !name || !category) {
        res.status(400);
        throw new Error("Please add all required fields");
      }
    
      const newMeditation = await Meditation.create({
        description,
        audio: audioBuffer,
        duration,
        image,
        name,
        category
      });
    
      if (newMeditation) {
        res.status(201).json({
          _id: newMeditation.id,
          audio: newMeditation.audio,
          description: newMeditation.description,
          duration: newMeditation.duration,
          image: newMeditation.image,
          name: newMeditation.name,
          category: newMeditation.category
        });
      } else {
        res.status(400);
        throw new Error("Meditation wasn't registered correctly");
      }
})

const editMeditation = asyncHanlder(async(req, res) => {
  const updatedMeditation = await Meditation.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
});

if (!updatedMeditation) {
    res.status(404);
    throw new Error("WhitenNose not found");
}

res.status(200).json(updatedMeditation);
})

const deleteMeditation = asyncHanlder(async(req, res) => {
  const deletedMeditation = await Meditation.findByIdAndDelete(req.params.id);

  if (!deletedMeditation) {
      res.status(404);
      throw new Error("deletedMeditation not found");
  }

  res.status(200).json({ message: `deletedMeditation with id ${req.params.id} deleted successfully` });
})

module.exports = {
    getMeditations,
    createMeditation,
    editMeditation,
    deleteMeditation
}