const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const multer = require("multer");
const upload = multer(); // Configuración básica en memoria

const { createrecipe } = require("../controllers/recipeController");

// Crear registro
// router.post(
//   "/createMaintenance",
//   upload.array("photos", 20),
//   protect,
//   createMaintenance
// );

router.post("/create", protect, createrecipe);

module.exports = router;
