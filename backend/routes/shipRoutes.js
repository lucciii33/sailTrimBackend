const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");

const {
  createShip,
  getShipById,
  deleteShipById,
  updateShipById,
  getShipByUserId,
} = require("../controllers/shipController");

router.post("/createShip", protect, createShip);
router.put("/updateShipById/:id", protect, updateShipById);
router.get("/getShipById/:id", protect, getShipById);
router.get("/getShipByUserId/:id", protect, getShipByUserId);
router.delete("/deleteShipById/:id", protect, deleteShipById);

module.exports = router;
