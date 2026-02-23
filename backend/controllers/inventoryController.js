const Inventory = require("../model/InventoryModel");
const asyncHandler = require("express-async-handler");

const createItem = asyncHandler(async (req, res) => {
  const resp = req.body;

  try {
    const item = await Inventory.create({
      ...req.body,
      owner: req.user._id,
    });
    return res.status(201).json(item);
  } catch (error) {
    return res.status(500).json({
      message: "Internal server error",
    });
  }
});

const getItemById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const item = await Inventory.findById(id);

  if (!item) {
    return res.status(404).json({ message: "Item not found" });
  }

  return res.json(item);
});

const getItemsByUserId = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const items = await Inventory.find({ owner: id });

  if (!items || items.length === 0) {
    return res.status(404).json({ message: "Items not found" });
  }

  return res.json(items);
});

const deleteItemById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const item = await Inventory.findByIdAndDelete(id);
  if (!item) {
    return res.status(404).json({ message: "Item not found" });
  }

  return res.json({ message: "Item deleted successfully" });
});

const updateItemById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const data = req.body;

  const items = await Inventory.findByIdAndUpdate(id, data, { new: true });
  if (!items) {
    return res.status(404).json({ message: "Item not found" });
  }

  return res.json(items);
});

module.exports = {
  createItem,
  getItemById,
  deleteItemById,
  updateItemById,
  getItemsByUserId,
};
