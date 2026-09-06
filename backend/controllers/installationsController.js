const Installation = require("../model/Installation");
const PendingInstall = require("../model/PendingInstall");
const {
  uninstallApp,
  fetchInstallationReposForModel,
} = require("../services/githubService");
const { logEvent } = require("../services/auditLogger");

// Which installations this user is allowed to see.
//
// A GitHub App installs on an ORG, not on a person, but `Installation.userId`
// records only whoever connected it first. Scoping the list to that one id made
// an org install invisible to every teammate — the approver connects it and the
// person who actually asked for it sees nothing. Docs are already company-wide
// (docController scopes by companyId), so the repo list matching that is what
// makes the two consistent.
//
// companyId is only added to the filter when the user actually has one:
// `{ companyId: undefined }` is not an empty match in Mongo, it matches every
// document with no companyId — i.e. it would leak unlinked installs to anyone.
function visibilityFilter(user) {
  const uid = user._id;
  const clauses = [{ userId: uid }, { userId: String(uid) }];
  if (user.companyId) clauses.push({ companyId: user.companyId });
  return { $or: clauses };
}

function toRepoRows(installations) {
  return installations.flatMap((inst) =>
    (inst.repos || []).map((r) => ({
      installationId: inst.installationId,
      owner: inst.accountLogin,
      accountType: inst.accountType,
      repo: r.repoName,
      fullName: r.repoFullName,
    }))
  );
}

// Install requests this user has sent that nobody has approved yet.
//
// Until now a request vanished the moment it was made: GitHub showed a "sent to
// the owner" page and Olivia showed an empty repo list, identical to never
// having asked. People re-requested, assumed it was broken, or gave up. Showing
// the outstanding request is what turns silence into a status.
//
// GitHub does not tell us which organisation was picked on a pending request
// (the callback carries no account), so a request is reported by when it was
// made, not by org.
async function listPendingRequests(req, res) {
  const pending = await PendingInstall.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .lean();

  res.json(
    pending.map((p) => ({
      id: String(p._id),
      requestedAt: p.createdAt,
      githubUsername: p.githubRequesterLogin || "",
      // A request with no captured GitHub id can never be matched to its
      // approval, so it needs a different message than "just wait".
      linkable: Boolean(p.githubRequesterId),
    }))
  );
}

async function listInstallations(req, res) {
  const installations = await Installation.find(visibilityFilter(req.user)).sort(
    { installedAt: -1 }
  );

  res.json(toRepoRows(installations));
}

// Manual "Refresh repositories" — re-reads every installation this user can see
// straight from GitHub and rewrites the stored repo list.
//
// The `installation_repositories` webhook keeps this current on its own, but a
// webhook that was never delivered (the event wasn't subscribed yet, the server
// was down, the signature failed) leaves a repo list that is wrong forever with
// no way for the user to fix it. This is that way out — and it's safe to spam,
// since it only ever replaces the list with what GitHub reports right now.
async function syncInstallations(req, res) {
  const installations = await Installation.find(visibilityFilter(req.user));

  const failed = [];
  await Promise.all(
    installations.map(async (inst) => {
      try {
        const fresh = await fetchInstallationReposForModel(inst.installationId);
        // Refuse to turn a working install into an empty one. GitHub answering
        // with nothing is far more likely to be a transient token/propagation
        // problem than the customer genuinely having zero repos, and the cost
        // of believing it is wiping their whole list.
        if (fresh.length === 0 && (inst.repos || []).length > 0) {
          console.error(
            `[installations] refusing to wipe ${inst.repos.length} repo(s) for ` +
              `install=${inst.installationId}: GitHub returned an empty list`
          );
          failed.push(inst.installationId);
          return;
        }
        inst.repos = fresh;
        await inst.save();
      } catch (err) {
        // One dead installation (revoked on GitHub, suspended) must not sink
        // the refresh for the others — report it and keep the rest.
        console.error(
          `[installations] sync failed for ${inst.installationId}:`,
          err.message
        );
        failed.push(inst.installationId);
      }
    })
  );

  const fresh = await Installation.find(visibilityFilter(req.user)).sort({
    installedAt: -1,
  });

  res.json({ repos: toRepoRows(fresh), synced: installations.length, failed });
}

// Hard disconnect: actually revokes the GitHub App's access (not just a
// local flag). Docs/bugs already generated for these repos are left alone —
// only the Installation record (the connection itself) is removed. If the
// user wants these repos back later, they go through Connect GitHub again
// and get a new installationId, same as a first-time setup.
async function disconnectInstallation(req, res) {
  const { installationId } = req.params;

  const installation = await Installation.findOne({
    installationId,
    ...visibilityFilter(req.user),
  });

  if (!installation) {
    return res.status(404).json({ message: "Installation not found" });
  }

  try {
    await uninstallApp(installation.installationId);
  } catch (err) {
    if (err.status !== 404) {
      console.error("Error uninstalling GitHub App:", err);
      return res
        .status(502)
        .json({ message: "Could not revoke GitHub access. Try again." });
    }
    // Already uninstalled on GitHub's side — fine, just clean up locally.
  }

  await Installation.deleteOne({ _id: installation._id });

  await logEvent({
    event: "github_installation_disconnected",
    req,
    user: req.user,
    targetType: "Installation",
    targetId: String(installation.installationId),
    metadata: { accountLogin: installation.accountLogin },
  });

  res.json({ success: true });
}

module.exports = {
  listInstallations,
  listPendingRequests,
  syncInstallations,
  disconnectInstallation,
};
