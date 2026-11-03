const Order = require("../model/orderModel");
const asyncHandler = require("express-async-handler");
const Inventory = require("../model/orderModel"); // ajusta el path si es diferente

const createOrder = asyncHandler(async (req, res) => {
  const resp = req.body;
  try {
    const order = await Order.create(resp);
    return res.status(201).json(order);
  } catch (error) {
    console.error("createOrder error:", error); // 👈 agrega esto
    return res.status(500).json({ message: "Internal server error" });
  }
});

const getOrderById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const order = await Order.findById(id);

  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  return res.json(order);
});

const getOrdersByUserId = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const orders = await Order.find({ owner: id });

  if (!orders || orders.length === 0) {
    return res.status(404).json({ message: "Orders not found" });
  }

  return res.json(orders);
});

const deleteOrderById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const order = await Order.findByIdAndDelete(id);
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  return res.json({ message: "Order deleted successfully" });
});

const updateOrderById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const order = await Order.findById(id);
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  if (status === "accepted" && !order.inventoryDeducted) {
    // Primero verificar que haya stock suficiente para todos los items
    for (const item of order.items) {
      const product = await Inventory.findById(item.product);
      if (!product) {
        return res.status(404).json({ message: `Producto no encontrado` });
      }
      if (product.quantity < item.quantity) {
        return res.status(400).json({
          message: `Stock insuficiente para "${product.name}". Disponible: ${product.quantity}`,
        });
      }
    }

    for (const item of order.items) {
      await Inventory.findByIdAndUpdate(item.product, {
        $inc: { quantity: -item.quantity },
      });
    }

    order.inventoryDeducted = true;
  }

  if (status === "cancelled" && order.inventoryDeducted) {
    for (const item of order.items) {
      await Inventory.findByIdAndUpdate(item.product, {
        $inc: { quantity: +item.quantity },
      });
    }

    order.inventoryDeducted = false;
  }

  if (status === "cancelled" && order.inventoryDeducted) {
    for (const item of order.items) {
      await Inventory.findByIdAndUpdate(item.product, {
        $inc: { quantity: +item.quantity },
      });
    }
    order.inventoryDeducted = false;
  }

  order.status = status;
  await order.save();

  return res.json(order);
});

module.exports = {
  createOrder,
  getOrderById,
  deleteOrderById,
  updateOrderById,
  getOrdersByUserId,
};
