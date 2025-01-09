const asyncHanlder = require("express-async-handler");
const Audio = require("../model/audioToTextModel");

const getAudiosByUserId = asyncHanlder(async (req, res) => {
  const { userId } = req.params;
  const userAudios = await Audio.find({ userId });

  if (!userAudios) {
    res.status(404);
    throw new Error("no audios para este usuario");
  }

  res.json(userAudios);
});

const createText = asyncHanlder(async (req, res) => {
  const { transcript, userId, title } = req.body;
  if (!transcript || !userId || !title) {
    res.status(400);
    throw new Error("Please add all required fields");
  }

  const newTextFromAudio = await Audio.create({
    transcript,
    userId,
    title,
  });

  if (newTextFromAudio) {
    res.status(201).json({
      _id: newTextFromAudio.id,
      transcript: newTextFromAudio.transcript,
      userId: newTextFromAudio.userId,
      title: newTextFromAudio.title,
    });
  } else {
    res.status(400);
    throw new Error("Problems");
  }
});

const editAudiosByUserId = asyncHanlder(async (req, res) => {
  const { audioId } = req.params;
  const updatedAudios = await Audio.findByIdAndUpdate(audioId, req.body, {
    new: true,
  });

  if (!updatedAudios) {
    res.status(404);
    throw new Error("estos Apuntes no se encuentran");
  }

  res.status(200).json(updatedAudios);
});

const deleteAudioByUserId = asyncHanlder(async (req, res) => {
  const { audioId } = req.params;
  const deleteAudios = await Audio.findByIdAndDelete(audioId);

  if (!deleteAudios) {
    res.status(404);
    throw new Error("este audio no se encuentran");
  }
  res.status(200).json({
    message: `Audio con el id ${audioId} deleted successfully`,
  });
});

module.exports = {
  getAudiosByUserId,
  createText,
  editAudiosByUserId,
  deleteAudioByUserId,
};
