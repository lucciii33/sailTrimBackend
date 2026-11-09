const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const PrReview = require("../model/PrReviewModel");
const BusinessRule = require("../model/BusinessRuleModel");
const ApiQaConfig = require("../model/ApiQaConfig");
const prReviewChat = require("../services/prReviewChatService");

// Reading Olivia's PR reviews, answering its questions, and recording the
// team's decision. Scoped to the caller's company throughout.

function requireCompany(req, res) {
  if (!req.user.companyId) {
    res.status(400).json({ message: "User has no company" });
    return false;
  }
  return true;
}

async function findOwn(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ message: "Review not found" });
    return null;
  }
  const review = await PrReview.findOne({ _id: req.params.id, companyId: req.user.companyId });
  if (!review) res.status(404).json({ message: "Review not found" });
  return review;
}

/** GET /api/pr-reviews?owner=&repo= — newest first, without the evidence. */
const listReviews = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const filter = { companyId: req.user.companyId };
  if (req.query.owner && req.query.repo) {
    filter.owner = String(req.query.owner);
    filter.repo = String(req.query.repo);
  }
  const list = await PrReview.find(filter)
    .select("-tests.request -tests.response -chat")
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json(list);
});

/** GET /api/pr-reviews/:id — everything, evidence included. */
const getReview = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const review = await findOwn(req, res);
  if (review) res.json(review);
});

/**
 * POST /api/pr-reviews/:id/questions/:questionId/answer
 * { answer, rule?: { text, kind } } — with `rule`, the answer is also saved as
 * an approved business rule so the next review already knows it.
 */
const answerQuestion = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const review = await findOwn(req, res);
  if (!review) return;
  const question = review.questions.id(req.params.questionId);
  if (!question) return res.status(404).json({ message: "Question not found" });
  const answer = String(req.body?.answer || "").trim();
  if (!answer) return res.status(400).json({ message: "answer is required" });

  question.answer = answer.slice(0, 1000);
  question.answeredBy = req.user._id;
  question.answeredAt = new Date();

  const ruleText = String(req.body?.rule?.text || "").trim();
  if (ruleText) {
    const rule = await BusinessRule.create({
      companyId: req.user.companyId,
      owner: review.owner,
      repo: review.repo,
      kind: BusinessRule.KINDS.includes(req.body.rule.kind) ? req.body.rule.kind : "rule",
      text: ruleText.slice(0, 500),
      appliesTo: question.endpoint ? [question.endpoint] : [],
      status: "approved",
      source: "user",
      evidence: { prNumber: review.prNumber, files: [], note: `Answer to: ${question.text}`.slice(0, 300) },
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
    });
    question.ruleId = rule._id;
  }
  await review.save();
  res.json(review);
});

/** PATCH /api/pr-reviews/:id/decision { decision: approved|rejected, note } */
const decide = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const decision = req.body?.decision;
  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ message: "decision must be approved or rejected" });
  }
  const review = await findOwn(req, res);
  if (!review) return;
  review.decision = decision;
  review.decisionNote = String(req.body?.note || "").slice(0, 1000);
  review.decidedBy = req.user._id;
  review.decidedAt = new Date();
  await review.save();
  res.json(review);
});

/** POST /api/pr-reviews/:id/chat { message } — talk to the agent about this review. */
const chat = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Review not found" });
  }
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ message: "message is required" });
  const review = await prReviewChat.chat({
    reviewId: req.params.id,
    companyId: req.user.companyId,
    message,
  });
  res.json(review);
});

/**
 * POST /api/pr-reviews/:id/actions/:actionId { decision: apply|dismiss }
 * Applies what the agent proposed to keep: a repo variable or a business rule.
 */
const resolveAction = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const decision = req.body?.decision;
  if (!["apply", "dismiss"].includes(decision)) {
    return res.status(400).json({ message: "decision must be apply or dismiss" });
  }
  const review = await findOwn(req, res);
  if (!review) return;
  const action = review.chat
    .flatMap((m) => m.actions || [])
    .find((a) => String(a._id) === req.params.actionId);
  if (!action) return res.status(404).json({ message: "Action not found" });
  if (action.status !== "pending") return res.json(review);

  if (decision === "apply" && action.kind === "save_variable") {
    const config = await ApiQaConfig.findOne({
      companyId: req.user.companyId,
      owner: review.owner,
      repo: review.repo,
    });
    if (!config) {
      return res.status(400).json({ message: "Set up this repo's QA config (URL and auth) first" });
    }
    const rest = (config.variables || []).filter((v) => v.key !== action.key);
    config.variables = [...rest, { key: action.key, value: action.value, secret: false }];
    config.updatedAt = new Date();
    await config.save();
  }
  if (decision === "apply" && action.kind === "save_rule") {
    await BusinessRule.create({
      companyId: req.user.companyId,
      owner: review.owner,
      repo: review.repo,
      kind: BusinessRule.KINDS.includes(action.ruleKind) ? action.ruleKind : "rule",
      text: action.ruleText,
      appliesTo: action.endpoint ? [action.endpoint] : [],
      status: "approved",
      source: "user",
      evidence: { prNumber: review.prNumber, files: [], note: "Agreed in the review chat" },
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
    });
  }
  action.status = decision === "apply" ? "applied" : "dismissed";
  await review.save();
  res.json(review);
});

module.exports = { listReviews, getReview, answerQuestion, decide, chat, resolveAction };
