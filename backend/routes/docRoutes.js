const express = require("express");
const router = express.Router();
const { getDocs, deleteDoc } = require("../controllers/docController");
const { protect } = require("../middleware/authMiddleware");

router.get("/", protect, getDocs);
router.delete("/:id", protect, deleteDoc);

module.exports = router;
