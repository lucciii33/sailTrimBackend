const express = require("express");
const router = express.Router();

const {
  createMarina,
  updateMarina,
} = require("../controllers/marinasController");

router.post("/marinas", createMarina);
router.put("/marinas", updateMarina);

module.exports = router;
