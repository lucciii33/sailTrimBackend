const request = require("supertest");
const app = require("../server");
const authUser = require("./setup/authUtils.test");
const createBoat = require("../test/utils/createBoat");
const { buildShipPayload } = require("../test/factories/ship.factory");

let token;
let userId;
let boatId;

beforeAll(async () => {
  const auth = await authUser();
  token = auth.token;
  userId = auth.userId;
});

describe("Boat creation", () => {
  it("should create a boat with a valid token", async () => {
    const boatData = buildShipPayload({ owner: userId });

    const res = await request(app)
      .post("/api/ship/createShip")
      .set("Authorization", `Bearer ${token}`)
      .send(boatData);
    console.log("res", res);

    expect(res.statusCode).toBe(201);
    expect(res.body.name).toBe(boatData.name);
    expect(res.body.owner).toBe(userId);

    boatId = res.body._id;
  });
});

describe("create Boat with wrong token", () => {
  it("boat shoud not be created due to token is invalid or expired", async () => {
    const boatData = buildShipPayload({ owner: userId });
    const res = await request(app)
      .post("/api/ship/createShip")
      .set("Authorization", "Bearer invalid-token-233443")
      .send(boatData);
    expect(res.statusCode).toBe(401);
  });
});

describe("Boat creation faild due to missing validation", () => {
  it("should no create a boat due too flag is mandatory", async () => {
    const boatData = buildShipPayload({ owner: userId, flag: "" });

    const res = await request(app)
      .post("/api/ship/createShip")
      .set("Authorization", `Bearer ${token}`)
      .send(boatData);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe("Validation error");
  });
});

describe("Boat get by id", () => {
  it("should get a boat with a valid id", async () => {
    const res = await request(app)
      .get(`/api/ship/getShipById/${boatId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body._id).toBe(boatId);
    expect(res.body.owner).toBe(userId);
  });
});

describe("delete a bout by id", () => {
  it("should delete a boat with a valid id", async () => {
    const res = await request(app)
      .delete(`/api/ship/deleteShipById/${boatId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe("Ship deleted successfully");
  });
});

describe("edit bout by id", () => {
  it("should edit a boat by id", async () => {
    const boatFunc = await createBoat(buildShipPayload({ owner: userId }));
    console.log("boatFuncboatFunc", boatFunc);

    const res = await request(app)
      .put(`/api/ship/updateShipById/${boatFunc._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "updated boat name" });

    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe("updated boat name");
  });
});

describe("edit boat by id with a wrong if", () => {
  it("should not edit a boat with wrong id", async () => {
    const boatFunc = await createBoat(buildShipPayload({ owner: userId }));

    const res = await request(app)
      .put(`/api/ship/updateShipById/507f1f77bcf86cd799439011`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "updated boat name" });

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toBe("Ship not found");
  });
});
