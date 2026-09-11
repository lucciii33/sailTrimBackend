const mongoose = require("mongoose");

const mcpProjectSchema = new mongoose.Schema(
  {
    projectName: { type: String, required: true },
    name: { type: String, required: true },
    config: { type: mongoose.Schema.Types.Mixed, required: true },
    configEncrypted: { type: String },
    resources: [mongoose.Schema.Types.Mixed],
    prompts: [mongoose.Schema.Types.Mixed],
    lastConnectedAt: Date,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
  },
  { timestamps: true }
);

mcpProjectSchema.index({ companyId: 1, projectName: 1 }, { unique: true });

// El blob cifrado nunca sale en una respuesta HTTP: solo se usa server-side
// (decryptConfig) para reconstruir la config real. Sigue accesible en el doc
// de mongoose, esto solo afecta la serializacion.
mcpProjectSchema.set("toJSON", {
  transform: (_doc, ret) => {
    delete ret.configEncrypted;
    return ret;
  },
});

module.exports = mongoose.model("McpProject", mcpProjectSchema);
