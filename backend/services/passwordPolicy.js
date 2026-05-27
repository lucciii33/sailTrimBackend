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
    return "La contraseña es obligatoria.";
  }
  if (password.length < MIN_LENGTH) {
    return `La contraseña debe tener ${MIN_LENGTH} caracteres o más.`;
  }
  if (password.length > 128) {
    return "La contraseña no puede tener más de 128 caracteres.";
  }
  if (!/[A-Z]/.test(password)) {
    return "La contraseña debe contener al menos una letra mayúscula.";
  }
  if (!/[a-z]/.test(password)) {
    return "La contraseña debe contener al menos una letra minúscula.";
  }
  if (!/\d/.test(password)) {
    return "La contraseña debe contener al menos un número.";
  }
  if (!/[!@#$%^&*(),.?":{}|<>_\-+=/\\[\]~`';]/.test(password)) {
    return "La contraseña debe contener al menos un símbolo.";
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return "Esta contraseña es demasiado común. Elige una diferente.";
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
