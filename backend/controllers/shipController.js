const Ship = require("../model/boatModel");
const asyncHandler = require("express-async-handler");

// const createShip = asyncHandler(async (req, res) => {
//   const resp = req.body;
//   console.log("DATA PARA CREAR SHIP:", resp);
//   // const exists = await Ship.findOne({ _id: resp._id });

//   // if (exists) {
//   //   throw new Error("El barco ya existe");
//   // }

//   const ship = await Ship.create(resp);
//   console.log("SHIP CREADO REAL:", ship);

//   return res.status(201).json(ship);
// });
const createShip = asyncHandler(async (req, res) => {
  const resp = req.body;

  try {
    const ship = await Ship.create(resp);
    return res.status(201).json(ship);
  } catch (error) {
    if (error.name === "ValidationError") {
      const fields = {};

      for (const key in error.errors) {
        fields[key] = error.errors[key].message;
      }

      return res.status(400).json({
        message: "Validation error",
        fields,
      });
    }

    return res.status(500).json({
      message: "Internal server error",
    });
  }
});

const getShipById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const ship = await Ship.findById(id);

  if (!ship) {
    return res.status(404).json({ message: "Ship not found" });
  }

  return res.json(ship);
});

const getShipByUserId = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const ships = await Ship.find({ owner: id });

  if (!ships) {
    return res.status(404).json({ message: "Ship not found" });
  }

  return res.json(ships);
});

const deleteShipById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const ship = await Ship.findByIdAndDelete(id);
  if (!ship) {
    return res.status(404).json({ message: "Ship not found" });
  }

  return res.json({ message: "Ship deleted successfully" });
});

const updateShipById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const data = req.body;

  const ship = await Ship.findByIdAndUpdate(id, data, { new: true });
  if (!ship) {
    return res.status(404).json({ message: "Ship not found" });
  }

  return res.json(ship);
});

module.exports = {
  createShip,
  getShipById,
  deleteShipById,
  updateShipById,
  getShipByUserId,
};
