const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { requireBudget } = require("../middleware/budgetMiddleware");
const c = require("../controllers/prReviewController");

// Olivia's QA reviews of merged pull requests.
router.get("/", protect, c.listReviews);
router.get("/:id", protect, c.getReview);
router.post("/:id/questions/:questionId/answer", protect, c.answerQuestion);
router.patch("/:id/decision", protect, c.decide);
router.post("/:id/chat", protect, requireBudget("api"), c.chat);
router.post("/:id/actions/:actionId", protect, c.resolveAction);

module.exports = router;
