const express = require("express");
const router = express.Router();
const { handleWebhook, handleInstanceIdentity } = require("../controllers/webhookController");

router.post("/", handleWebhook);
router.post("/identity", handleInstanceIdentity);

module.exports = router;
