const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const multer = require("multer");
const upload = multer(); // Configuración básica en memoria

const {
  createMaintenance,
  //   getMaintenanceLogs,
  //   getMaintenanceById,
  getFullMaintenanceAudit,
  verifyChainIntegrity,
  verifyBlockchainTimestamp,
} = require("../controllers/maintenanceController");

// Crear registro
router.post(
  "/createMaintenance",
  upload.array("photos", 20),
  protect,
  createMaintenance
);

// // Obtener todos los logs de un barco
// router.get("/getMaintenanceLogs/:shipId", protect, getMaintenanceLogs);

// // Obtener un log específico
// router.get("/getMaintenanceById/:id", protect, getMaintenanceById);

// Verificar integridad de la cadena de un barco
router.get("/verifyChainIntegrity/:shipId", protect, verifyChainIntegrity);
router.get("/getFullMaintenanceAudit/:logId", protect, getFullMaintenanceAudit);

// Verificar timestamp de blockchain de un registro
router.get(
  "/verifyBlockchainTimestamp/:id",
  protect,
  verifyBlockchainTimestamp
);

module.exports = router;
