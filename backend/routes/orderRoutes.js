const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");

const {
  createOrder,
  getOrderById,
  getOrdersByUserId,
  deleteOrderById,
  updateOrderById,
} = require("../controllers/orderController");

router.post("/createOrder", protect, createOrder);
router.get("/getOrderById/:id", protect, getOrderById);
router.get("/getOrdersByUserId/:id", protect, getOrdersByUserId);
router.delete("/deleteOrderById/:id", protect, deleteOrderById);
router.put("/updateOrderById/:id", protect, updateOrderById);

module.exports = router;
