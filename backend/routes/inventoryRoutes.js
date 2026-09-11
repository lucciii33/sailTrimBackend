const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const multer = require("multer");
const upload = multer(); // Configuración básica en memoria

const {
  createItem,
  getItemById,
  deleteItemById,
  updateItemById,
  getItemsByUserId,
} = require("../controllers/inventoryController");

router.post("/createItem", protect, createItem);
router.get("/getItemById/:id", protect, getItemById);
router.get("/getItemsByUserId/:id", getItemsByUserId);
router.delete("/deleteItemById/:id", protect, deleteItemById);
router.put("/updateItemById/:id", protect, updateItemById);

module.exports = router;
