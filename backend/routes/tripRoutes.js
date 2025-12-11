const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");

const {
  createTrip,
  getTripById,
  updateTripById,
} = require("../controllers/tripController");

router.post("/createTrip", createTrip, protect);
router.put("/updateTripById/:id", updateTripById, protect);
router.get("/getTripById/:id", getTripById, protect);

module.exports = router;
