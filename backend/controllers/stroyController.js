const asyncHanlder = require("express-async-handler");
const Story = require("../model/storyModel");

const stories = asyncHanlder(async (req, res) => {
  const allStories = await Story.find();
  res.status(200).json(allStories);
});

const getStoryById = asyncHanlder(async (req, res) => {
  const { id } = req.params;
  const story = await Story.findById(id);

  if (!story) {
    res.status(404);
    throw new Error("Historia no encontrada.");
  }

  res.status(200).json(story);
});

const createStory = asyncHanlder(async (req, res) => {
  const {
    title,
    description,
    author,
    storyImage,
    coverImage,
    genre,
    language,
    ageRange,
    chapters,
  } = req.body;

  if (!title || !description || !author || !storyImage || !ageRange) {
    res.status(400);
    throw new Error("Faltan datos obligatorios.");
  }

  const newStory = new Story({
    title,
    description,
    author,
    storyImage,
    coverImage,
    genre,
    language,
    ageRange,
    chapters,
    published: true, // Por defecto, la historia no está publicada
  });

  const savedStory = await newStory.save();
  res.status(201).json(savedStory);
});

const editStory = asyncHanlder(async (req, res) => {
  const { id } = req.params;
  const updatedStory = await Story.findByIdAndUpdate(id, req.body, {
    new: true,
  });

  if (!updatedStory) {
    res.status(404);
    throw new Error("Historia no encontrada.");
  }

  res.status(200).json(updatedStory);
});

const deleteStory = asyncHanlder(async (req, res) => {
  const { id } = req.params;
  const story = await Story.findById(id);

  if (!story) {
    res.status(404);
    throw new Error("Historia no encontrada.");
  }

  await story.deleteOne();
  res.status(200).json({ message: "Historia eliminada con éxito" });
});

module.exports = {
  stories,
  deleteStory,
  createStory,
  editStory,
  getStoryById,
};
