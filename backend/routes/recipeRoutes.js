const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const multer = require("multer");
const upload = multer();

const {
  createrecipe,
  createRecipeAfter,
  getRecipeById,
  getRecipeByUserId,
  deleteRecipeById,
  updateRecipeById,
} = require("../controllers/recipeController");

// Crear registro
// router.post(
//   "/createMaintenance",
//   upload.array("photos", 20),
//   protect,
//   createMaintenance
// );

router.post("/create", protect, createrecipe);
router.post("/createAfter", protect, createRecipeAfter);
router.get("/getById/:id", protect, getRecipeById);
router.get("/getByUserId/:id", protect, getRecipeByUserId);
router.delete("/deleteById/:id", protect, deleteRecipeById);
router.put("/updateById/:id", protect, updateRecipeById);

module.exports = router;
