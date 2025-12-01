const asyncHandler = require("express-async-handler");
const {
  createMarinaService,
  updateMarinaService,
} = require("../services/marinaService");

// CREATE
const createMarina = asyncHandler(async (req, res) => {
  const marina = await createMarinaService(req.body);

  res.status(201).json({
    success: true,
    message: "Marina creada",
    marina,
  });
});

// UPDATE
const updateMarina = asyncHandler(async (req, res) => {
  const marina = await updateMarinaService(req.body);

  res.status(200).json({
    success: true,
    message: "Marina actualizada",
    marina,
  });
});

module.exports = {
  createMarina,
  updateMarina,
};
