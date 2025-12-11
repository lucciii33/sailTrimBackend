const mongoose = require("mongoose");

const LogbookEntrySchema = new mongoose.Schema(
  {
    // --- 1. Referencias (Quién y Dónde) ---
    trip: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      required: true,
    },
    responsibleUser: {
      type: String,
      required: true,
    },

    // --- 2. Metadatos y Tipo de Evento ---
    recordTime: {
      type: Date,
      required: true,
    },
    entryType: {
      type: String,
      required: true,
    },

    // --- 3. Posición y Navegación (RUMBO, VELOCIDAD, POSICIÓN) ---
    positionLat: {
      type: Number,
      required: false,
    },
    positionLon: {
      type: Number,
      required: false,
    },
    heading: {
      type: Number,
      required: false,
    },
    speed: {
      type: Number,
      required: false,
    },

    // --- 4. Condiciones Externas (MAR y VIENTO) ---
    windDirection: {
      type: String,
      required: false,
    },
    windIntensity: {
      type: Number,
      required: false,
    },
    seaState: {
      type: String,
      required: false,
    },
    visibility: {
      type: String,
      required: false,
    },

    // --- 5. Eventos y Descripciones (LO QUE SUCEDIÓ) ---
    eventDescription: {
      type: String,
      required: false,
    },
    engineStatus: {
      type: String,
      required: false,
    },

    // --- 6. El Sello Legal (Inmutabilidad) ---
    cryptographicHash: {
      type: String,
      required: true,
      unique: true,
    },
    previousHash: {
      type: String,
      required: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LogbookEntry", LogbookEntrySchema);
