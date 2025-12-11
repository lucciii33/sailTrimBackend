const Trip = require("../model/tripModel");
const asyncHandler = require("express-async-handler");

const createTrip = asyncHandler(async (req, res) => {
  const resp = req.body;
  const exists = await Trip.findOne({ _id: resp._id });

  if (exists) {
    throw new Error("El barco ya existe");
  }
  const trip = await Trip.create(resp);
  res.json(trip);
});

const getTripById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const trip = await Trip.findById(id);

  if (!trip) {
    return res.status(404).json({ message: "Ship not found" });
  }

  return res.json(trip);
});

const deleteTripById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const trip = await Trip.findByIdAndDelete(id);
  if (!trip) {
    return res.status(404).json({ message: "Ship not found" });
  }

  return res.json({ message: "Ship deleted successfully" });
});

const updateTripById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const data = req.body;

  const trip = await Trip.findByIdAndUpdate(id, data, { new: true });
  if (!trip) {
    return res.status(404).json({ message: "Ship not found" });
  }

  return res.json(trip);
});

module.exports = {
  createTrip,
  getTripById,
  deleteTripById,
  updateTripById,
};
