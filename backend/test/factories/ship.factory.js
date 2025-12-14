const buildShipPayload = (overrides = {}) => ({
  name: "Titanic 2",
  owner: null, //we add it on the test
  flag: "ES",
  registerNumber: "ABC123",
  yearBuilt: "2005",
  lengthOverall: "12",
  beam: "4",
  displacement: "8",
  mainEngineHours: "1200",
  generatorHours: "400",
  nextInspectionDate: "2026-01-01",
  ...overrides,
});

module.exports = {
  buildShipPayload,
};
