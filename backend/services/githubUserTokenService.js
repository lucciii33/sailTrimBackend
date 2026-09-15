const User = require("../model/userModel");
const { encrypt, decrypt } = require("./secretCrypto");

// The signed-in user's GitHub token — needed for the few GitHub actions only a
// USER can perform, like removing one repository from an app installation.

async function saveUserGithubTokens(userId, { accessToken, refreshToken, expiresIn }) {
  if (!userId || !accessToken) return;
  await User.findByIdAndUpdate(userId, {
    githubTokenEncrypted: encrypt(accessToken),
    githubRefreshTokenEncrypted: refreshToken ? encrypt(refreshToken) : "",
    // Apps with expiring tokens send expires_in; apps without them don't, and
    // those tokens simply don't expire.
    githubTokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
  });
}

async function clearUserGithubToken(userId) {
  await User.findByIdAndUpdate(userId, {
    githubTokenEncrypted: "",
    githubRefreshTokenEncrypted: "",
    githubTokenExpiresAt: null,
  });
}

/**
 * A usable token for this user, refreshing it if it expired. Returns null when
 * there is none (they connected before tokens were stored, or it was revoked)
 * — callers then ask the user to sign in with GitHub once.
 */
async function getUserGithubToken(userId) {
  const user = await User.findById(userId).select(
    "githubTokenEncrypted githubRefreshTokenEncrypted githubTokenExpiresAt"
  );
  if (!user?.githubTokenEncrypted) return null;

  const expiresAt = user.githubTokenExpiresAt?.getTime();
  // A minute of margin so a token doesn't expire mid-request.
  if (!expiresAt || expiresAt - 60000 > Date.now()) {
    return decrypt(user.githubTokenEncrypted) || null;
  }

  const refreshToken = decrypt(user.githubRefreshTokenEncrypted);
  if (!refreshToken) return null;

  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const data = await res.json();
    if (!data.access_token) {
      await clearUserGithubToken(userId);
      return null;
    }
    await saveUserGithubTokens(userId, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    });
    return data.access_token;
  } catch (err) {
    console.error("[github] token refresh failed:", err.message);
    return null;
  }
}

module.exports = { saveUserGithubTokens, clearUserGithubToken, getUserGithubToken };
