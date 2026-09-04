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
  listFeatures,
  createFeature,
  deleteFeature,
  generateFromVideo,
  listTests,
  getTest,
  createTest,
  updateTest,
  recordLogin,
  recordTest,
  improveTest,
  commitTest,
  deleteTest,
  startClientRecording,
  ingestClientRecording,
  finishClientRecording,
  startCloudLogin,
  finishCloudLogin,
} = require("../controllers/e2eQaController");

// The injected recorder POSTs events as text/plain (CORS-simple, no preflight).
// This route needs its own text parser since the app's global json parser
// won't touch text/plain bodies.
const ingestBodyParser = express.text({ type: "*/*", limit: "256kb" });

// Projects (tied to user + company)
router.get("/projects", protect, listProjects);
router.post("/projects", protect, createProject);
router.get("/projects/:id", protect, getProject);
router.put("/projects/:id", protect, updateProject);
router.delete("/projects/:id", protect, deleteProject);

// Features (group tests inside a project; the video is dropped on a feature)
router.get("/projects/:id/features", protect, listFeatures);
router.post("/projects/:id/features", protect, createFeature);
router.delete("/features/:featureId", protect, deleteFeature);

// Feature 1: upload a demo video to a FEATURE → BDD test cases (draft tests)
router.post(
  "/features/:featureId/from-video",
  protect,
  upload.single("video"),
  generateFromVideo
);
// Tests of a feature.
router.get("/features/:featureId/tests", protect, listTests);
// Write a case by hand (no video) — same shape as a generated one.
router.post("/features/:featureId/tests", protect, createTest);

// Feature 2: capture the login session ONCE for the project.
// record-login spawns Playwright codegen on the SERVER — local dev only (a
// deployed backend has no display). The cloud pair below is the one that works
// in production; both write to the same project session.
router.post("/projects/:id/record-login", protect, recordLogin);
router.post("/projects/:id/cloud-login/start", protect, startCloudLogin);
router.post("/cloud-login/:recordingId/finish", protect, finishCloudLogin);

// Tests
router.get("/projects/:id/tests", protect, listTests);
router.get("/tests/:testId", protect, getTest);
// Edit the name/kind/Gherkin of any case, generated or hand-written.
router.put("/tests/:testId", protect, updateTest);
// Feature 2: record the flow with Playwright → saves the spec on the test.
router.post("/tests/:testId/record", protect, recordTest);

// Cloud recorder (SaaS): the customer records in an embedded Browserbase
// browser — no install, no changes to their app.
router.post("/tests/:testId/client-record/start", protect, startClientRecording);
router.post("/recordings/:recordingId/finish", protect, finishClientRecording);
// Public ingest — authenticated by the per-session token in the body, not the
// user cookie (it's called from inside the cloud browser). CORS-open for the
// text/plain beacon; preflight answered here too.
router.options("/recordings/ingest", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.status(204).end();
});
router.post("/recordings/ingest", ingestBodyParser, ingestClientRecording);
// Feature 3: read the repo + rewrite the recording senior-quality + self-heal
// until it passes → saves the green spec + heal log on the test.
router.post("/tests/:testId/improve", protect, improveTest);
// Commit & push the green spec to the project's connected repo (direct to branch).
router.post("/tests/:testId/commit", protect, commitTest);
router.delete("/tests/:testId", protect, deleteTest);

module.exports = router;
