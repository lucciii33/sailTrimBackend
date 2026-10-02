const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, unique: true },

    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    customer: {
      name: { type: String, required: true },
      email: { type: String },
      phone: { type: String },
    },

    items: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Inventory",
          required: true,
        },
        quantity: { type: Number, required: true, min: 1 },
        unitPrice: { type: Number, required: true },
        subtotal: { type: Number, required: true },
      },
    ],

    status: {
      type: String,
      enum: ["pending", "accepted", "cancelled"],
      default: "pending",
    },

    inventoryDeducted: { type: Boolean, default: false },

    total: { type: Number, required: true },
    currency: { type: String, default: "USD" },
    notes: { type: String },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Order", OrderSchema);
