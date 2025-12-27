const MaintenanceLog = require("../model/MaintenanceLogModel");
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const OpenTimestamps = require("javascript-opentimestamps");
const { uploadEvidence } = require("../services/aws.js");

/* =====================================================
   ORDENAMIENTO DETERMINÍSTICO
===================================================== */
const sortObjectKeys = (obj) => {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);

  const sorted = {};
  Object.keys(obj)
    .sort()
    .forEach((key) => {
      sorted[key] = sortObjectKeys(obj[key]);
    });

  return sorted;
};

/* =====================================================
   CÁLCULO DE HASH
===================================================== */
const calculateHash = (data) => {
  const normalized = normalizeForHash(data);
  const sorted = sortObjectKeys(normalized);

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex");
};

const normalizeForHash = (data) => {
  // 1. Forzamos a que sea un objeto simple de JS
  let obj = JSON.parse(JSON.stringify(data.toObject ? data.toObject() : data));

  // 2. Limpieza de campos que Mongoose o el sistema añaden después
  const fieldsToExclude = [
    "_id",
    "__v",
    "createdAt",
    "updatedAt",
    "cryptographicHash",
    "blockchainTimestamp",
  ];
  fieldsToExclude.forEach((field) => delete obj[field]);

  // 3. Normalización de Datos Críticos
  if (obj.ship) obj.ship = obj.ship.toString();

  // Convertimos recordTime a ISO string para que no haya líos de milisegundos vs fechas
  if (obj.recordTime) {
    obj.recordTime = new Date(obj.recordTime).toISOString();
  }

  // 4. Limpieza profunda de la secuencia de fotos
  if (Array.isArray(obj.evidenceSequence)) {
    obj.evidenceSequence = obj.evidenceSequence.map((item) => ({
      photoURL: item.photoURL,
      photoHash: item.photoHash,
      stepNumber: Number(item.stepNumber),
      // Igual que arriba, fecha estandarizada
      stepCompletionTime: new Date(item.stepCompletionTime).toISOString(),
    }));
  }

  // 5. Convertir CUALQUIER número que venga como string (desde Postman) a Número real
  // Esto evita que "1385" sea diferente a 1385
  if (obj.hoursMeter) obj.hoursMeter = Number(obj.hoursMeter);
  if (obj.partsCost) obj.partsCost = Number(obj.partsCost);

  // 6. Eliminar nulos, vacíos y arrays vacíos
  Object.keys(obj).forEach((key) => {
    if (obj[key] === null || obj[key] === undefined || obj[key] === "")
      delete obj[key];
    if (Array.isArray(obj[key]) && obj[key].length === 0) delete obj[key];
  });

  return obj;
};

/* =====================================================
   CREATE MAINTENANCE (CORREGIDO)
===================================================== */
const createMaintenance = asyncHandler(async (req, res) => {
  const bodyData = { ...req.body };
  const files = req.files;
  let evidenceSequence = [];

  if (files && files.length > 0) {
    for (let i = 0; i < files.length; i++) {
      const uploadResult = await uploadEvidence(
        files[i].buffer,
        files[i].originalname,
        files[i].mimetype
      );
      evidenceSequence.push({
        photoURL: uploadResult.url,
        photoHash: uploadResult.hash,
        stepNumber: i + 1,
        stepCompletionTime: new Date(),
      });
    }
  }

  const recordTime = bodyData.recordTime
    ? new Date(bodyData.recordTime)
    : new Date();

  const lastLog = await MaintenanceLog.findOne({ ship: bodyData.ship })
    .sort({ recordTime: -1 })
    .select("cryptographicHash")
    .lean();

  const previousHash = lastLog ? lastLog.cryptographicHash : "GENESIS_BLOCK";

  // --- EL CAMBIO CLAVE ESTÁ AQUÍ ---
  // Primero creamos el registro SIN el hash para que Mongoose lo normalice
  const tempLog = new MaintenanceLog({
    ...bodyData,
    evidenceSequence,
    recordTime,
    previousHash,
  });

  // Ahora generamos el hash usando el objeto ya procesado por Mongoose
  const cryptographicHash = calculateHash(tempLog);
  tempLog.cryptographicHash = cryptographicHash;

  // Sello OTS
  try {
    const detached = OpenTimestamps.DetachedTimestampFile.fromHash(
      new OpenTimestamps.Ops.OpSHA256(),
      Buffer.from(cryptographicHash, "hex")
    );
    await OpenTimestamps.stamp(detached);
    // Creamos un Buffer real antes de convertir a texto para que no se pierda info
    const proofBuffer = Buffer.from(detached.serializeToBytes());

    tempLog.blockchainTimestamp = {
      otsProof: proofBuffer.toString("base64"),
      stampedAt: new Date(),
    };
  } catch (err) {
    console.log("OTS Error", err.message);
  }

  const savedLog = await tempLog.save();

  res.status(201).json({ success: true, data: savedLog });
});

/* =====================================================
   OTRAS FUNCIONES (Buscadores y Verificadores)
===================================================== */
const getMaintenanceLogs = asyncHandler(async (req, res) => {
  const { shipId } = req.params;
  const logs = await MaintenanceLog.find({ ship: shipId }).sort({
    recordTime: -1,
  });
  res.status(200).json({ success: true, count: logs.length, data: logs });
});

const getMaintenanceById = asyncHandler(async (req, res) => {
  const log = await MaintenanceLog.findById(req.params.logId);
  if (!log) {
    res.status(404);
    throw new Error("No encontrado");
  }
  res.status(200).json({ success: true, data: log });
});

const verifyChainIntegrity = asyncHandler(async (req, res) => {
  const logs = await MaintenanceLog.find({ ship: req.params.shipId }).sort({
    recordTime: 1,
  });
  if (!logs.length)
    return res
      .status(404)
      .json({ success: false, message: "No hay registros" });

  let isValid = true;
  let tamperedLog = null;

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i].toObject();
    const recalculatedHash = calculateHash(log);
    if (recalculatedHash !== log.cryptographicHash) {
      isValid = false;
      tamperedLog = log._id;
      break;
    }
    if (i > 0 && log.previousHash !== logs[i - 1].cryptographicHash) {
      isValid = false;
      tamperedLog = log._id;
      break;
    }
  }

  res.status(200).json({ success: true, isValid, tamperedLog });
});

const verifyBlockchainTimestamp = asyncHandler(async (req, res) => {
  const log = await MaintenanceLog.findById(req.params.id);

  if (!log || !log.blockchainTimestamp?.otsProof) {
    return res
      .status(404)
      .json({ success: false, message: "No hay sello en la base de datos" });
  }

  try {
    const buffer = Buffer.from(log.blockchainTimestamp.otsProof, "base64");

    // Si el buffer es muy corto, el registro se guardó mal y no hay nada que hacer con él
    if (buffer.length < 50) {
      return res.status(200).json({
        success: false,
        message:
          "Este registro específico se guardó incompleto. No se puede verificar.",
      });
    }

    const detached = OpenTimestamps.DetachedTimestampFile.deserialize(buffer);

    // Intentamos el upgrade, si falla no pasa nada, seguimos
    try {
      await OpenTimestamps.upgrade(detached);
    } catch (e) {
      // Ignoramos error de red
    }

    const result = await OpenTimestamps.verify(detached);

    res.status(200).json({
      success: true,
      verified: result !== undefined,
      timestamp: result ? new Date(result * 1000) : null,
      message: result
        ? "Verificado en Bitcoin"
        : "Sello detectado, esperando confirmación de la red",
    });
  } catch (error) {
    // AQUÍ ESTÁ EL TRUCO: Si sale el error de fileDigest, lo capturamos aquí
    res.status(200).json({
      success: false,
      message: "El formato de este sello es inválido o está incompleto.",
      details: "Este registro fue creado antes de las correcciones de formato.",
    });
  }
});

const getFullMaintenanceAudit = asyncHandler(async (req, res) => {
  const log = await MaintenanceLog.findById(req.params.logId);

  if (!log) {
    res.status(404);
    throw new Error("Registro no encontrado");
  }

  const currentHash = calculateHash(log);
  const isIntegrityIntact = currentHash === log.cryptographicHash;

  res.status(200).json({
    success: true,
    integrityVerified: isIntegrityIntact,
    auditDetails: {
      systemStatus: isIntegrityIntact ? "CERTIFIED_ORIGINAL" : "DATA_TAMPERED",
      recalculatedHash: currentHash,
      originalHash: log.cryptographicHash,
    },
    data: log,
  });
});

module.exports = {
  createMaintenance,
  getMaintenanceLogs,
  getMaintenanceById,
  verifyChainIntegrity,
  verifyBlockchainTimestamp,
  getFullMaintenanceAudit,
};
