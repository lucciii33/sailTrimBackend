const express = require("express");
const {
  stories,
  createStory,
  editStory,
  deleteStory,
  getStoryById,
} = require("../controllers/stroyController");

const router = express.Router();

router.get("/", stories); // Obtener todas las historias
router.get("/:id", getStoryById); // Obtener todas las historias
router.post("/", createStory); // Crear una nueva historia
router.put("/:id", editStory); // Editar historia por ID
router.delete("/:id", deleteStory); // Eliminar historia por ID

module.exports = router;
