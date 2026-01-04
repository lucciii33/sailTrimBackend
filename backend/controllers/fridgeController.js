const Fridge = require("../model/fridgeModel");
const asyncHandler = require("express-async-handler");

const createFridge = asyncHandler(async (req, res) => {
  const resp = req.body;

  try {
    const fridge = await Fridge.create(resp);
    return res.status(201).json(fridge);
  } catch (error) {
    return res.status(500).json({
      message: "Internal server error",
    });
  }
});

const getFridgeById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const fridge = await Fridge.findById(id);

  if (!fridge) {
    return res.status(404).json({ message: "Fridge not found" });
  }

  return res.json(fridge);
});

const getFridgeByUserId = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const fridges = await Fridge.find({ owner: id });

  if (!fridges) {
    return res.status(404).json({ message: "Fridge not found" });
  }

  return res.json(fridges);
});

const deleteFridgeById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const fridge = await Fridge.findByIdAndDelete(id);
  if (!fridge) {
    return res.status(404).json({ message: "Fridge not found" });
  }

  return res.json({ message: "Fridge deleted successfully" });
});

const updateFridgeById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const data = req.body;

  const fridges = await Fridge.findByIdAndUpdate(id, data, { new: true });
  if (!fridges || fridges.length === 0) {
    return res.status(404).json({ message: "Fridge not found" });
  }

  return res.json(fridges);
});

module.exports = {
  createFridge,
  getFridgeById,
  deleteFridgeById,
  updateFridgeById,
  getFridgeByUserId,
};
