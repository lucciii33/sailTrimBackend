const asyncHanlder = require("express-async-handler");
const Map = require("../model/mapsModel");

const getMapsUserId = asyncHanlder(async (req, res) => {
  const userMaps = await Map.find({ userId: req.params.userId });

  if (!userMaps) {
    res.status(404);
    throw new Error("No se encontraron Mapas mentales para este usuario");
  }

  res.json(userMaps);
});

const getMapById = asyncHanlder(async (req, res) => {
  const mapId = req.params.mapId; // Obtén el ID de la tarea desde los parámetros de la URL

  // Implementa la lógica para buscar la tarea por su ID
  const mapaMental = await Map.findById(mapId);

  if (!mapaMental) {
    res.status(404);
    throw new Error("mapa mental sin encontrar");
  }

  res.json(mapaMental);
});

const createMap = asyncHanlder(async (req, res) => {
  const { topic, textAi, userId } = req.body;

  if (!topic || !textAi) {
    res.status(400);
    throw new Error("Por Favor llene todos los campos");
  }

  const nuevoMapaMental = await Map.create({
    topic,
    textAi,
    userId,
  });

  if (nuevoMapaMental) {
    res.status(201).json({
      _id: nuevoMapaMental.id,
      topic: nuevoMapaMental.topic,
      textAi: nuevoMapaMental.textAi,
      userId: nuevoMapaMental.userId,
    });
  } else {
    res.status(400);
    throw new Error("mapas no se han generado coreactamente");
  }
});

const editMap = asyncHanlder(async (req, res) => {
  const editaMapasMentales = await Map.findByIdAndUpdate(
    req.params.id,
    req.body,
    {
      new: true,
    }
  );

  if (!editaMapasMentales) {
    res.status(404);
    throw new Error("estos Apuntes no se encuentran");
  }

  res.status(200).json(editaMapasMentales);
});

const deleteMap = asyncHanlder(async (req, res) => {
  const deletedMapaMental = await Map.findByIdAndDelete(req.params.id);

  if (!deletedMapaMental) {
    res.status(404);
    throw new Error("estos Apuntes no se encuentran");
  }

  res.status(200).json({
    message: `mapa mental con el id ${req.params.id} deleted successfully`,
  });
});

module.exports = {
  getMapsUserId,
  getMapById,
  createMap,
  editMap,
  deleteMap,
};
