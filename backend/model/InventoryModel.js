const mongoose = require("mongoose");

const InventorySchema = new mongoose.Schema(
  {
    // Identificación básica
    name: {
      type: String,
      required: true,
      trim: true,
    },

    sku: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    barcode: {
      type: String,
      required: false,
      trim: true,
    },

    description: {
      type: String,
      required: false,
      trim: true,
    },

    // Propietario / empresa
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Stock
    quantity: {
      type: Number,
      required: true,
      default: 0,
    },

    minimumStock: {
      type: Number,
      default: 0, // alerta de stock bajo
    },

    // Unidad de medida
    unit: {
      type: String,
      enum: ["unit", "kg", "g", "liter", "meter", "box"],
      default: "unit",
    },

    // Precios
    costPrice: {
      type: Number,
      required: false,
      default: 0,
    },

    salePrice: {
      type: Number,
      required: false,
      default: 0,
    },

    currency: {
      type: String,
      default: "USD",
    },

    // Ubicación
    location: {
      type: String,
      required: false, // Ej: "Warehouse A / Shelf 3"
    },

    // Proveedor
    supplier: {
      type: String,
      required: false,
    },

    // Fechas importantes
    expirationDate: {
      type: Date,
      required: false,
    },

    lastRestockedAt: {
      type: Date,
      required: false,
    },

    // Estado
    isActive: {
      type: Boolean,
      default: true,
    },

    images: [
      {
        type: String,
      },
    ],
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Inventory", InventorySchema);
