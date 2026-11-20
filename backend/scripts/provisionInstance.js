// Creates the first workspace and owner of a dedicated instance. Sign-up is off
// there, so without this nobody could ever get in.
//
//   node scripts/provisionInstance.js --company "Acme" --email owner@acme.com \
//     --first-name Ana --last-name Lopez
//
// Prints a link where the owner sets their password. It holds a secret: send it
// to them directly and don't paste it in a shared channel. Valid for 24 hours.
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../model/userModel");
const Company = require("../model/companyModel");
const { hashPassword } = require("../services/passwordPolicy");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, "")] = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = (args.email || "").toLowerCase().trim();
  if (!args.company || !email.includes("@")) {
    throw new Error('Usage: --company "Acme" --email owner@acme.com');
  }
  if (!process.env.MONGO_URL || !process.env.FRONTEND_URL) {
    throw new Error("MONGO_URL and FRONTEND_URL must be set");
  }

  await mongoose.connect(process.env.MONGO_URL);
  if (await User.exists({ email })) {
    throw new Error(`${email} already has an account on this instance`);
  }

  // Nobody knows this password. It exists because the reset flow compares the
  // new password against the current one.
  const unusable = await hashPassword(crypto.randomBytes(32).toString("hex"));
  const resetToken = crypto.randomBytes(32).toString("hex");

  const user = await User.create({
    firstName: args["first-name"] || email.split("@")[0],
    lastName: args["last-name"] || "Owner",
    email,
    password: unusable,
    terms: true,
    role: "owner",
    resetPasswordToken: crypto.createHash("sha256").update(resetToken).digest("hex"),
    resetPasswordExpire: Date.now() + 24 * 60 * 60 * 1000,
    passwordChangedAt: new Date(),
  });
  const company = await Company.create({
    name: args.company,
    ownerUserId: user._id,
    plan: "enterprise",
    planNote: "Dedicated instance",
  });
  user.companyId = company._id;
  await user.save();

  const base = process.env.FRONTEND_URL.replace(/\/+$/, "");
  console.log(`Created "${company.name}" with owner ${email}`);
  console.log(`Set password: ${base}/reset-password/${resetToken}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
