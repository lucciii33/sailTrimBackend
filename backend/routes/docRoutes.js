const express = require("express");
const router = express.Router();
const {
  listDocEnvironments, getDocs, deleteDoc } = require("../controllers/docController");
const { protect } = require("../middleware/authMiddleware");

router.get("/", protect, getDocs);
// Which environments (branches) this repo has docs for.
router.get("/environments", protect, listDocEnvironments);
router.delete("/:id", protect, deleteDoc);

module.exports = router;
