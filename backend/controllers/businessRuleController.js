const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const BusinessRule = require("../model/BusinessRuleModel");
const rules = require("../services/businessRuleService");

// Reviewing what Olivia proposed, adding rules by hand, and exporting them.
// Every query is scoped to the caller's company.

function scopeFromQuery(q) {
  if (q.owner && q.repo) return { owner: String(q.owner), repo: String(q.repo) };
  if (q.projectId && mongoose.isValidObjectId(q.projectId)) {
    return { projectId: q.projectId };
  }
  return null;
}

function requireCompany(req, res) {
  if (!req.user.companyId) {
    res.status(400).json({ message: "User has no company" });
    return false;
  }
  return true;
}

/** GET /api/rules?owner=&repo=  or  ?projectId=   [&status=] */
const listRules = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const filter = { companyId: req.user.companyId };
  const scope = scopeFromQuery(req.query);
  if (scope) Object.assign(filter, scope);
  if (BusinessRule.STATUSES.includes(req.query.status)) filter.status = req.query.status;
  const list = await BusinessRule.find(filter).sort({ status: 1, updatedAt: -1 }).limit(500).lean();
  res.json(list);
});

/** POST /api/rules — a rule written by a person is approved from the start. */
const createRule = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const scope = scopeFromQuery(req.body || {});
  const text = String(req.body?.text || "").trim();
  if (!scope || !text) {
    return res.status(400).json({ message: "A repo (owner and repo) or projectId, and text, are required" });
  }
  const rule = await BusinessRule.create({
    companyId: req.user.companyId,
    ...scope,
    kind: BusinessRule.KINDS.includes(req.body.kind) ? req.body.kind : "rule",
    text,
    appliesTo: Array.isArray(req.body.appliesTo) ? req.body.appliesTo.map(String) : [],
    status: "approved",
    source: "user",
    reviewedBy: req.user._id,
    reviewedAt: new Date(),
  });
  res.status(201).json(rule);
});

/** PATCH /api/rules/:id — approve, reject, or correct the wording. */
const updateRule = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Rule not found" });
  }
  const set = {};
  if (req.body.text !== undefined) {
    const text = String(req.body.text).trim();
    if (!text) return res.status(400).json({ message: "text can't be empty" });
    set.text = text;
  }
  if (req.body.kind !== undefined) {
    if (!BusinessRule.KINDS.includes(req.body.kind)) {
      return res.status(400).json({ message: "Unknown kind" });
    }
    set.kind = req.body.kind;
  }
  if (Array.isArray(req.body.appliesTo)) set.appliesTo = req.body.appliesTo.map(String);
  if (req.body.status !== undefined) {
    if (!BusinessRule.STATUSES.includes(req.body.status)) {
      return res.status(400).json({ message: "Unknown status" });
    }
    set.status = req.body.status;
    set.reviewedBy = req.user._id;
    set.reviewedAt = new Date();
  }
  const rule = await BusinessRule.findOneAndUpdate(
    { _id: req.params.id, companyId: req.user.companyId },
    { $set: set },
    { new: true }
  );
  if (!rule) return res.status(404).json({ message: "Rule not found" });
  res.json(rule);
});

/** DELETE /api/rules/:id */
const deleteRule = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Rule not found" });
  }
  const r = await BusinessRule.deleteOne({ _id: req.params.id, companyId: req.user.companyId });
  if (!r.deletedCount) return res.status(404).json({ message: "Rule not found" });
  res.json({ ok: true });
});

/** GET /api/rules/export.md?owner=&repo= — the approved rules as Markdown. */
const exportRules = asyncHandler(async (req, res) => {
  if (!requireCompany(req, res)) return;
  const scope = scopeFromQuery(req.query);
  if (!scope) return res.status(400).json({ message: "owner and repo, or projectId, are required" });
  const list = await BusinessRule.find({
    companyId: req.user.companyId,
    ...scope,
    status: "approved",
  })
    .sort({ kind: 1, createdAt: 1 })
    .lean();
  const title = scope.repo ? `Business rules: ${scope.owner}/${scope.repo}` : "Business rules";
  res.type("text/markdown").send(rules.toMarkdown(list, title));
});

module.exports = { listRules, createRule, updateRule, deleteRule, exportRules };
