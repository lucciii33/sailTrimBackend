const mongoose = require("mongoose");

const StorySchema = new mongoose.Schema({
  title: { type: String, required: true }, // Título del cuento
  description: { type: String, required: true }, // Descripción breve del cuento
  author: { type: String, required: true }, // Autor del cuento
  storyImage: { type: String, required: true }, // Imagen general del cuento (URL)
  coverImage: { type: String }, // Imagen de portada (URL)
  genre: { type: String }, // Género (fantasía, terror, ciencia ficción, etc.)
  language: { type: String, default: "es" }, // Idioma del cuento
  ageRange: { type: String, required: true }, // Rango de edad recomendado (Ej: "6-10 años")
  published: { type: Boolean, default: false }, // Estado de publicación
  chapters: [
    {
      number: { type: Number, required: true }, // Número del capítulo
      title: { type: String, required: true }, // Título del capítulo
      content: { type: String, required: true }, // Contenido del capítulo
      image: { type: String }, // Imagen opcional del capítulo
    },
  ],
  createdAt: { type: Date, default: Date.now }, // Fecha de creación
});

module.exports = mongoose.model("Story", StorySchema);
