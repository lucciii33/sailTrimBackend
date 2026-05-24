const Anthropic = require("@anthropic-ai/sdk");
const User = require("../model/userModel.js");
const { decrypt } = require("./secretCrypto.js");

async function getUserAnthropicClient(userId) {
  if (!userId) return null;
  const user = await User.findById(userId).select("anthropicKeyEncrypted");
  if (!user?.anthropicKeyEncrypted) return null;
  const apiKey = decrypt(user.anthropicKeyEncrypted);
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

module.exports = { getUserAnthropicClient };
