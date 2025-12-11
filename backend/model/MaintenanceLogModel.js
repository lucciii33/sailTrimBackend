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

    // --- 6. El Sello Legal ---
    cryptographicHash: { type: String, required: true, unique: true },
    previousHash: { type: String, required: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MaintenanceLog", MaintenanceLogSchema);
