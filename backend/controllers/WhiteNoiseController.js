const asyncHanlder = require('express-async-handler')
const WhiteNose = require('../model/whiteNoiseModel')

const getWhitenNose = asyncHanlder(async(req, res) => {
    const whiteNose = await WhiteNose.find();
    res.json(whiteNose);
})

const createWhitenNose = asyncHanlder(async(req, res) => {
    const {
        description,
        duration,
        image,
        name,
        category
      } = req.body;
    
      console.log(req.body);

    //   const audioBuffer = req.file.buffer;

    //   if (!req.file || !req.file.buffer) {
    //     res.status(400);
    //     throw new Error("Audio file is missing");
    //   }
    //|| !audioBuffer
      if (!description || !duration  || !name || !category) {
        res.status(400);
        throw new Error("Please add all required fields");
      }
    
      const newWhiteNose = await WhiteNose.create({
        description,
        // audio: audioBuffer,
        duration,
        image,
        name,
        category
      });
    
      if (newWhiteNose) {
        res.status(201).json({
          _id: newWhiteNose.id,
        //   audio: newWhiteNose.audio,
          description: newWhiteNose.description,
          duration: newWhiteNose.duration,
          image: newWhiteNose.image,
          name: newWhiteNose.name,
          category: newWhiteNose.category
        });
      } else {
        res.status(400);
        throw new Error("Meditation wasn't registered correctly");
      }
})

const editWhitenNose = asyncHanlder(async(req, res) => {
    const updatedWhitenNose = await WhiteNose.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
    });

    if (!updatedWhitenNose) {
        res.status(404);
        throw new Error("WhitenNose not found");
    }

    res.status(200).json(updatedWhitenNose);
})

const deleteWhitenNose = asyncHanlder(async(req, res) => {
    const deletedWhitenNose = await WhiteNose.findByIdAndDelete(req.params.id);

    if (!deletedWhitenNose) {
        res.status(404);
        throw new Error("WhitenNose not found");
    }

    res.status(200).json({ message: `WhitenNose with id ${req.params.id} deleted successfully` });
})

module.exports = {
    getWhitenNose,
    createWhitenNose,
    editWhitenNose,
    deleteWhitenNose
}