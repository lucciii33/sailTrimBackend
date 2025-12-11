const mongoose = require("mongoose");

const ShipSchema = new mongoose.Schema({
  name: {
    type: String,
    required: false,
    trim: true,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  flag: {
    type: String,
    required: false,
    enum: ["ES", "US", "UK", "PA", "OTRO"], // Banderas comunes para Compliance
  },
  registerNumber: {
    type: String,
    unique: false,
    required: false,
  },
  yearBuilt: {
    type: String,
    required: false,
  },

  // --- Dimensiones y Características Técnicas (Datos Reales) ---
  lengthOverall: {
    type: String,
    required: false,
    unit: "metros",
  },
  beam: {
    type: String,
    required: false,
    unit: "metros",
    description: "El ancho del barco.",
  },
  displacement: {
    type: String,
    unit: "toneladas",
  },
  mainEngineHours: {
    type: String,
    default: 0,
  },
  generatorHours: {
    type: String,
    default: 0,
  },

  nextInspectionDate: {
    type: String,
  },
});

module.exports = mongoose.model("Ship", ShipSchema);
