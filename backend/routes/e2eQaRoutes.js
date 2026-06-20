const express = require("express");
const router = express.Router();
const multer = require("multer");
// In-memory (same as other upload routes). 250MB cap so a huge screen recording
// can't OOM the server — ffmpeg then strips it down to a small mp3 for Whisper.
const upload = multer({ limits: { fileSize: 250 * 1024 * 1024 } });
const { protect } = require("../middleware/authMiddleware");
const {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  generateFromVideo,
  listTests,
  getTest,
  recordLogin,
  recordTest,
  improveTest,
  deleteTest,
} = require("../controllers/e2eQaController");

// Projects (tied to user + company)
router.get("/projects", protect, listProjects);
router.post("/projects", protect, createProject);
router.get("/projects/:id", protect, getProject);
router.put("/projects/:id", protect, updateProject);
router.delete("/projects/:id", protect, deleteProject);

// Feature 1: upload a demo video → BDD test cases (draft tests)
router.post(
  "/projects/:id/from-video",
  protect,
  upload.single("video"),
  generateFromVideo
);

// Feature 2: capture the login session ONCE for the project.
router.post("/projects/:id/record-login", protect, recordLogin);

// Tests
router.get("/projects/:id/tests", protect, listTests);
router.get("/tests/:testId", protect, getTest);
// Feature 2: record the flow with Playwright → saves the spec on the test.
router.post("/tests/:testId/record", protect, recordTest);
// Feature 3: read the repo + rewrite the recording senior-quality + self-heal
// until it passes → saves the green spec + heal log on the test.
router.post("/tests/:testId/improve", protect, improveTest);
router.delete("/tests/:testId", protect, deleteTest);

module.exports = router;
