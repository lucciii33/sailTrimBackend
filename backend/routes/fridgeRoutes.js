const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const multer = require("multer");
const upload = multer(); // Configuración básica en memoria

const {
  createFridge,
  getFridgeById,
  deleteFridgeById,
  updateFridgeById,
  getFridgeByUserId,
} = require("../controllers/fridgeController");

// Crear registro
// router.post(
//   "/createMaintenance",
//   upload.array("photos", 20),
//   protect,
//   createMaintenance
// );

router.post("/createFridge", protect, createFridge);
router.get("/getFridgeById/:id", protect, getFridgeById);
router.get("/getFridgeByUserId/:id", protect, getFridgeByUserId);
router.delete("/deleteFridgeById/:id", protect, deleteFridgeById);
router.put("/updateFridgeById/:id", protect, updateFridgeById);

module.exports = router;
