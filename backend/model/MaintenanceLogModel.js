const mongoose = require("mongoose");

const MaintenanceLogSchema = new mongoose.Schema(
  {
    // --- Referencias ---
    ship: { type: mongoose.Schema.Types.ObjectId, ref: "Ship", required: true },
    responsibleUser: {
      type: String,
      required: true,
    },

    // --- 2. Metadatos y Clasificación ---
    recordTime: { type: Date, required: true },
    maintenanceDueDate: {
      type: Date,
      required: false, // Puede ser false porque DIY a veces no tiene fecha oficial
    },
    systemAffected: { type: String, required: true }, // Motor, Eléctrico, Casco
    maintenanceType: { type: String, required: true }, // Preventivo, Correctivo

    // --- 3. Descripción y Fallas ---
    descriptionActivity: { type: String, required: true },
    failureDescription: { type: String, required: false },
    statusBefore: { type: String, required: false },
    statusAfter: { type: String, required: true },

    // --- 4. Trazabilidad y Horas ---
    hoursMeter: { type: Number, required: false },
    timeSpentHours: { type: Number, required: false },
    executedBy: { type: String, required: false },

    // --- 5. Costos y Adjuntos (Auditoría Financiera) ---
    materialsUsed: { type: [String], required: false },
    partsCost: { type: Number, required: false },
    invoiceNumber: { type: String, required: false },

    // Campo de adjuntos
    attachments: {
      type: [String],
      required: false,
    },

    isDIY: {
      type: Boolean,
      required: false, // CLAVE: Distingue el flujo de datos (Factura vs. Secuencia)
    },
    protocolID: {
      type: String,
      required: false, // ID del Protocolo de Mantenimiento Oficial (IOM) seguido
    },
    evidenceSequence: {
      type: [
        {
          photoURL: String,
          stepNumber: Number,
          photoHash: String,
          geoHash: String,
          stepCompletionTime: Date,
        },
      ],
      required: false,
    },

    partsInstalledSerial: {
      type: [String],
      required: false, // Números de serie de las piezas instaladas (refuta el "es pirata")
    },

    estimatedDurationMinutes: {
      type: Number,
      required: false,
    },
    isInspectedByProfessional: {
      type: Boolean,
      required: false,
    },

    cryptographicHash: { type: String, required: true, unique: true },
    previousHash: { type: String, required: false },

    blockchainTimestamp: {
      otsProof: String,
      stampedAt: Date,
      verified: Boolean,
      verifiedAt: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MaintenanceLog", MaintenanceLogSchema);
