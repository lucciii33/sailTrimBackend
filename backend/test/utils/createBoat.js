const Boat = require("../../model/boatModel");

const createBoat = async (data) => {
  const boat = await Boat.create(data);
  return boat;
};

module.exports = createBoat;
