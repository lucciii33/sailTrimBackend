const request = require("supertest");
const app = require("../server");
const authUser = require("./setup/authUtils.test");
const createBoat = require("../test/utils/createBoat");

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
    const boatData = {
      name: "Titanic 2",
      owner: userId,
    };

    const res = await request(app)
      .post("/api/ship/createShip")
      .set("Authorization", `Bearer ${token}`)
      .send(boatData);

    expect(res.statusCode).toBe(201);
    expect(res.body.name).toBe(boatData.name);
    expect(res.body.owner).toBe(userId);

    boatId = res.body._id;
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
  it("should edit a bout by id", async () => {
    const boatFunc = await createBoat({ owner: userId, name: "new boat" });

    const res = await request(app)
      .put(`/api/ship/updateShipById/${boatFunc._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "updated boat name" });

    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe("updated boat name");
  });
});
