const Marina = require("../model/marinaModel");

async function createMarinaService(data) {
  const exists = await Marina.findOne({ placeId: data.placeId });

  if (exists) {
    throw new Error("La marina ya existe");
  }

  return await Marina.create(data);
}

async function updateMarinaService(data) {
  const marina = await Marina.findOneAndUpdate(
    { placeId: data.placeId },
    data,
    { new: true }
  );

  if (!marina) {
    throw new Error("Marina no encontrada");
  }

  return marina;
}

module.exports = {
  createMarinaService,
  updateMarinaService,
};
