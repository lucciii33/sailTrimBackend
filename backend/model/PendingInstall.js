const mongoose = require("mongoose");

/**
 * A one-shot record of "user X asked to install the GitHub App on an org
 * where they aren't an admin". At request time GitHub gives us the user's
 * identity (via the callback `state`) but NO installation yet — the install
 * only lands later, via the `installation.created` webhook, once the org
 * owner approves. That webhook does NOT carry our `state`, so without this
 * record the approved installation would be saved with no idea which customer
 * it belongs to (and would never show in their repo list).
 *
 * When the webhook arrives we claim the most recent pending record to link
 * the installation back to the requesting user. TTL-expires after 1 hour so
 * abandoned/never-approved requests don't linger and get mis-claimed by an
 * unrelated later install.
 */
const pendingInstallSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company" },
  createdAt: { type: Date, default: Date.now, expires: 3600 },
});

module.exports = mongoose.model("PendingInstall", pendingInstallSchema);
