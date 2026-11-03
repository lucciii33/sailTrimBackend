const bcrypt = require("bcryptjs");

const BCRYPT_COST = 12;
const MIN_LENGTH = 12;
const HISTORY_SIZE = 5;

const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "passw0rd",
  "qwerty",
  "qwerty123",
  "abc123",
  "111111",
  "123456",
  "12345678",
  "123456789",
  "1234567890",
  "letmein",
  "welcome",
  "welcome1",
  "admin",
  "admin123",
  "iloveyou",
  "monkey",
  "dragon",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "master",
  "shadow",
  "superman",
  "batman",
  "trustno1",
  "starwars",
  "freedom",
  "whatever",
  "ninja",
  "azerty",
  "solo",
  "passw0rd!",
  "p@ssw0rd",
  "p@ssword",
  "p@ssword1",
]);

function validatePasswordStrength(password) {
  if (!password || typeof password !== "string") {
    return "Password is required.";
  }
  if (password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters long.`;
  }
  if (password.length > 128) {
    return "Password must be 128 characters or fewer.";
  }
  if (!/[A-Z]/.test(password)) {
    return "Password must contain at least one uppercase letter.";
  }
  if (!/[a-z]/.test(password)) {
    return "Password must contain at least one lowercase letter.";
  }
  if (!/\d/.test(password)) {
    return "Password must contain at least one number.";
  }
  if (!/[!@#$%^&*(),.?":{}|<>_\-+=/\\[\]~`';]/.test(password)) {
    return "Password must contain at least one symbol.";
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return "This password is too common. Please choose a different one.";
  }
  return null;
}

async function hashPassword(password) {
  const salt = await bcrypt.genSalt(BCRYPT_COST);
  return bcrypt.hash(password, salt);
}

async function isReusedPassword(plainPassword, passwordHistory = []) {
  for (const entry of passwordHistory) {
    if (!entry || !entry.hash) continue;
    if (await bcrypt.compare(plainPassword, entry.hash)) {
      return true;
    }
  }
  return false;
}

function pushPasswordHistory(history = [], newHash) {
  const next = [{ hash: newHash, changedAt: new Date() }, ...history];
  return next.slice(0, HISTORY_SIZE);
}

module.exports = {
  BCRYPT_COST,
  MIN_LENGTH,
  HISTORY_SIZE,
  validatePasswordStrength,
  hashPassword,
  isReusedPassword,
  pushPasswordHistory,
};
