const request = require("supertest");
const app = require("../../server");
const User = require("../../model/userModel");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const validCredentials = {
  email: "testlogin@example.com",
  password: "Password!123",
};

const authUser = async () => {
  let user = await User.findOne({ email: validCredentials.email });
  if (!user) {
    const hashedPassword = await bcrypt.hash(validCredentials.password, 10);
    user = await User.create({
      firstName: "Juan",
      lastName: "Perez",
      email: validCredentials.email.toLowerCase(),
      password: hashedPassword,
      pais: "Argentina",
      edad: 35,
      terms: true,
    });
  }

  const res = await request(app).post("/api/user/login").send(validCredentials);

  const finalToken = res.body
    ? res.body.token
    : res._body
    ? res._body.token
    : undefined;
  const finalUserId = res.body
    ? res.body._id
    : res._body
    ? res._body._id
    : undefined;

  return {
    token: finalToken,
    userId: finalUserId,
  };
};

describe("login test", () => {
  it("login and return id and token", async () => {
    const { token, userId } = await authUser();

    expect(token).toBeDefined();
    expect(userId).toBeDefined();
  });
});

module.exports = authUser;
