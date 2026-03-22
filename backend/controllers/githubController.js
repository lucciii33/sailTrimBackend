const Installation = require("../model/Installation");

async function githubCallback(req, res) {
  const { installation_id, state } = req.query;

  if (!installation_id || !state) {
    return res.status(400).json({ message: "Missing installation_id or state" });
  }

  await Installation.findOneAndUpdate(
    { installationId: Number(installation_id) },
    { userId: state },
    { new: true, upsert: true }
  );

  res.status(200).json({ message: "Installation linked to user" });
}

module.exports = { githubCallback };
