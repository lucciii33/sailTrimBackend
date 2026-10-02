#!/usr/bin/env node
/**
 * Read-only diagnosis of "GitHub says approved, Olivia shows nothing".
 *
 * Prints, for one person: whether we ever captured their GitHub identity, what
 * install requests they have outstanding, and which installations they can
 * actually see — then names the specific reason a repo is missing.
 *
 * Writes nothing. Safe to run against production.
 *
 *   node diagnose-github.js <email> [orgLogin]
 */
const path = require("path");
// Resolve .env next to this script, not next to wherever it was invoked from —
// this gets run from other project folders by habit.
require("dotenv").config({ path: path.join(__dirname, ".env") });
const mongoose = require("mongoose");

const { fetchInstallationReposForModel } = require("./services/githubService");
const User = require("./model/userModel");
const Company = require("./model/companyModel");
const Installation = require("./model/Installation");
const PendingInstall = require("./model/PendingInstall");

const [email, scopeArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

if (!email) {
  console.error(
    "usage: node diagnose-github.js <email> [githubOrgLogin | companyId] [--live] [--all]"
  );
  process.exit(1);
}

// The second argument is whichever identifier happens to be at hand: the GitHub
// org name, or the Mongo companyId copied out of a document. Telling them apart
// by shape beats making the caller remember which one this wants.
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
// --live asks GitHub what each installation can actually see and diffs it
// against our copy. This is the only way to tell a genuinely-empty repo list
// from a stale one, which is the whole question when a repo "never showed up".
const CHECK_LIVE = flags.includes("--live");
// --all widens the last section to every installation in the database, so an
// install that was never stamped with a companyId still shows up.
const SHOW_ALL = flags.includes("--all");

const isObjectId = (v) => /^[0-9a-fA-F]{24}$/.test(v || "");
const scopeCompanyId = isObjectId(scopeArg) ? scopeArg : null;
const orgLogin = scopeArg && !scopeCompanyId ? scopeArg : null;

const line = (t = "") => console.log(t);
const head = (t) => {
  line();
  line(`── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
};

(async () => {
  await mongoose.connect(process.env.MONGO_URL);
  line(`connected: ${mongoose.connection.host}/${mongoose.connection.name}`);

  const problems = [];

  head("USER");
  const user = await User.findOne({ email: String(email).toLowerCase() }).select(
    "email companyId githubUserId githubUsername"
  );
  if (!user) {
    line(`no user with email ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  line(`_id            ${user._id}`);
  line(`email          ${user.email}`);
  line(`companyId      ${user.companyId || "(none)"}`);
  line(`githubUserId   ${user.githubUserId || "(EMPTY)"}`);
  line(`githubUsername ${user.githubUsername || "(EMPTY)"}`);

  // This is the single field the whole org-approval linking depends on. It is
  // written in exactly one place: the OAuth hop of "Connect GitHub".
  if (!user.githubUserId) {
    problems.push(
      "githubUserId is EMPTY — this account never completed the GitHub OAuth hop.\n" +
        "     An org owner's approval carries only the requester's GitHub id, so with\n" +
        "     nothing to match against, the approval cannot be linked to this account.\n" +
        "     FIX: have them click Connect GitHub once (they do NOT need to be admin)."
    );
  }

  if (user.companyId) {
    const company = await Company.findById(user.companyId).select(
      "name ownerUserId plan"
    );
    line(`company        ${company?.name || "?"} (owner ${company?.ownerUserId})`);
  } else {
    problems.push(
      "user has no companyId — they can only ever see installations linked to\n" +
        "     their own userId, never a teammate's."
    );
  }

  head("PENDING INSTALL REQUESTS (this user)");
  const pendings = await PendingInstall.find({ userId: user._id }).sort({
    createdAt: -1,
  });
  if (pendings.length === 0) {
    line("(none) — either never requested, already claimed, or expired (30d TTL)");
  }
  for (const p of pendings) {
    line(
      `- created ${p.createdAt.toISOString()}  requesterId=${
        p.githubRequesterId || "(EMPTY -> can never be matched)"
      } login=${p.githubRequesterLogin || "?"}`
    );
    if (!p.githubRequesterId) {
      problems.push(
        `pending request from ${p.createdAt.toISOString()} has no githubRequesterId,\n` +
          "     so approving it on GitHub will silently do nothing."
      );
    }
  }

  head("INSTALLATIONS THIS USER CAN SEE");
  const orClauses = [{ userId: user._id }, { userId: String(user._id) }];
  if (user.companyId) orClauses.push({ companyId: user.companyId });
  const visible = await Installation.find({ $or: orClauses });
  if (visible.length === 0) line("(none)");
  for (const i of visible) {
    const why = String(i.userId) === String(user._id) ? "own" : "via company";
    line(`- ${i.accountLogin} install=${i.installationId} (${why}) repos=${i.repos.length}`);
    i.repos.forEach((r) => line(`    · ${r.repoFullName}`));
  }

  head("UNLINKED INSTALLATIONS (nobody owns these)");
  const orphans = await Installation.find({ userId: null });
  if (orphans.length === 0) line("(none)");
  for (const i of orphans) {
    line(
      `- ${i.accountLogin} install=${i.installationId} repos=${i.repos.length} ` +
        `parkedRequesters=[${(i.pendingRequesterIds || []).join(", ") || "none"}]`
    );
    if ((i.pendingRequesterIds || []).includes(String(user.githubUserId))) {
      problems.push(
        `installation ${i.installationId} (${i.accountLogin}) is parked waiting for THIS user.\n` +
          "     It links itself the next time they click Connect GitHub."
      );
    }
  }

  if (orgLogin || scopeCompanyId) {
    const scopeLabel = orgLogin
      ? `ORG "${orgLogin}"`
      : `COMPANY ${scopeCompanyId}`;
    head(`ALL INSTALLATIONS FOR ${scopeLabel}`);

    if (scopeCompanyId) {
      const co = await Company.findById(scopeCompanyId).select(
        "name ownerUserId"
      );
      line(`company: ${co?.name || "(not found)"} owner=${co?.ownerUserId || "?"}`);
      line(
        `this user ${
          String(user.companyId) === String(scopeCompanyId)
            ? "IS"
            : "is NOT"
        } a member of it`
      );
      line();
    }

    const forOrg = await Installation.find(
      orgLogin ? { accountLogin: orgLogin } : { companyId: scopeCompanyId }
    );
    if (forOrg.length === 0) line("(none found for this scope)");
    for (const i of forOrg) {
      const owner = i.userId
        ? await User.findById(i.userId).select("email")
        : null;
      line(
        `- install=${i.installationId} owner=${owner?.email || "(UNLINKED)"} ` +
          `companyId=${i.companyId || "(none)"} repos=${i.repos.length}`
      );
      i.repos.forEach((r) => line(`    · ${r.repoFullName}`));

      // The tenancy limit: one installation stores exactly one userId, so a repo
      // approved for a teammate lands in whoever connected the org first.
      if (i.userId && String(i.userId) !== String(user._id)) {
        const sameCompany =
          user.companyId && String(i.companyId) === String(user.companyId);
        problems.push(
          `installation ${i.installationId} belongs to ${owner?.email || "someone else"}.\n` +
            `     ${user.email} ${sameCompany ? "CAN" : "CANNOT"} see it ` +
            `(${sameCompany ? "same company" : "different/!no company"}).`
        );
      }
    }
  }

  if (SHOW_ALL) {
    head("EVERY INSTALLATION IN THE DATABASE");
    const all = await Installation.find({}).sort({ installedAt: -1 });
    for (const i of all) {
      const owner = i.userId ? await User.findById(i.userId).select("email") : null;
      line(
        `- ${i.accountLogin} install=${i.installationId} ` +
          `owner=${owner?.email || "(UNLINKED)"} company=${i.companyId || "(NONE)"} repos=${i.repos.length}`
      );
      // An install with an owner but no companyId is invisible to that owner's
      // teammates, because company-wide visibility keys off exactly this field.
      if (i.userId && !i.companyId) {
        problems.push(
          `installation ${i.installationId} (${i.accountLogin}) has an owner but NO companyId,\n` +
            "     so nobody else in their workspace can see it. Needs a backfill."
        );
      }
    }
  }

  if (CHECK_LIVE) {
    head("LIVE CHECK — our repo list vs what GitHub actually says");
    const targets = SHOW_ALL ? await Installation.find({}) : visible;
    for (const i of targets) {
      let live;
      try {
        live = await fetchInstallationReposForModel(i.installationId);
      } catch (err) {
        line(`- ${i.accountLogin} install=${i.installationId}: GitHub error — ${err.message}`);
        continue;
      }
      const ours = new Set(i.repos.map((r) => r.repoFullName));
      const theirs = new Set(live.map((r) => r.repoFullName));
      const missing = [...theirs].filter((r) => !ours.has(r));
      const extra = [...ours].filter((r) => !theirs.has(r));

      line(
        `- ${i.accountLogin} install=${i.installationId}: ours=${ours.size} github=${theirs.size}`
      );
      missing.forEach((r) => line(`    MISSING (GitHub has it, we don't): ${r}`));
      extra.forEach((r) => line(`    STALE (we have it, GitHub doesn't): ${r}`));
      if (missing.length === 0 && extra.length === 0) line("    in sync");

      if (missing.length || extra.length) {
        problems.push(
          `installation ${i.installationId} (${i.accountLogin}) is OUT OF SYNC with GitHub:\n` +
            `     ${missing.length} missing, ${extra.length} stale. This is the bug, live.\n` +
            "     FIX: the Refresh button in the sidebar, or POST /api/installations/sync."
        );
      }
    }
  }

  head("VERDICT");
  if (problems.length === 0) {
    line("Nothing obviously wrong for this user.");
  } else {
    problems.forEach((p, n) => line(`${n + 1}.  ${p}`));
  }
  line();

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("diagnose failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
