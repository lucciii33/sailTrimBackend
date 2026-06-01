const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getConfig,
  upsertConfig,
  importProjectSpec,
  listProjects,
  getProjectDocs,
  setProjectAuth,
  getProjectSectionCollection,
  findBugs,
  getBugs,
  deleteBug,
  updateBugStatus,
  getCollection,
  listRuns,
  getRun,
} = require("../controllers/apiQAController");

router.get("/config/:owner/:repo", protect, getConfig);
router.put("/config/:owner/:repo", protect, upsertConfig);

// API Project (spec-import) flow
router.post("/projects/import", protect, importProjectSpec);
router.get("/projects", protect, listProjects);
router.get("/projects/:id/docs", protect, getProjectDocs);
router.put("/projects/:id/auth", protect, setProjectAuth);
router.get("/projects/:id/section-collection", protect, getProjectSectionCollection);

router.post("/find-bugs/:docId", protect, findBugs);
router.get("/bugs/:docId", protect, getBugs);
router.patch("/bugs/:id", protect, updateBugStatus);
router.delete("/bugs/:id", protect, deleteBug);

router.get("/collection/:docId", protect, getCollection);

router.get("/runs/:docId", protect, listRuns);
router.get("/run/:id", protect, getRun);

module.exports = router;
