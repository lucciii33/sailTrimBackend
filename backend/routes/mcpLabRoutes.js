const express = require("express");
const router = express.Router();
const c = require("../controllers/mcpLabController.js");

// --- Connection / introspection ---
router.post("/connect", c.connectServer);
router.post("/tools", c.getTools);

// --- Playground / runs ---
router.post("/invoke", c.invokeTool);
router.post("/run", c.runPrompt);

// --- LLM-as-Judge ---
router.post("/judge/:traceId", c.judge);
router.post("/compare/:traceId", c.compare);

// --- Test case generator ---
router.post("/generate-cases", c.generateCases);

// --- Generated MCP docs ---
router.post("/docs/generate", c.generateDocs);
router.get("/docs", c.listDocs);
router.get("/docs/:id", c.getDoc);
router.delete("/docs/:id", c.deleteDoc);

// --- Traces ---
router.get("/traces", c.listTraces);
router.get("/traces/:id", c.getTrace);
router.delete("/traces/:id", c.deleteTrace);

// --- Suites ---
router.post("/suites", c.createSuite);
router.get("/suites", c.listSuites);
router.get("/suites/:id", c.getSuite);
router.delete("/suites/:id", c.deleteSuite);
router.post("/suites/:id/run", c.runSuite);

module.exports = router;
