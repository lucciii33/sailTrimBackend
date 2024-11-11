const express = require("express");
const router = express.Router();
const {
  getMapsUserId,
  getMapById,
  createMap,
  editMap,
  deleteMap,
} = require("../controllers/mentalMapController");
const { protect } = require("../middleware/authMiddleware");

router.route("/getMapById/:mapId").get(protect, getMapById);
router.route("/getMapsUserId/:userId").get(protect, getMapsUserId);
router.route("/createMap").post(protect, createMap);
router.route("/editMap/:id").put(protect, editMap);
router.route("/deleteMap/:id").delete(protect, deleteMap);

module.exports = router;
