const request = require("supertest");
const app = require("../server");
const authUser = require("./setup/authUtils.test");
const Trip = require("../model/tripModel");
const createBoat = require("../test/utils/createBoat");

let token;
let userId;
let tripId;

beforeAll(async () => {
  const auth = await authUser();
  token = auth.token;
  userId = auth.userId;
});

describe("Trip creation", () => {
  it("should create a trip", async () => {
    const boatFunc = await createBoat({ owner: userId, name: "new boat" });
    const ship = {
      owner: boatFunc.owner,
      ship: boatFunc._id,
      responsibleCapitan: "Captain Jack",
      departurePort: "Miami",
      arrivalPort: "Bahamas",
      departureTime: new Date(),
      arrivalTime: new Date(Date.now() + 3600000),
      status: "PLANNED",
    };
    const res = await request(app)
      .post("/api/trip/createTrip")
      .set("Authorization", `Bearer ${token}`)
      .send(ship);
    tripId = res._id;

    expect(res.statusCode).toBe(200);
    expect(res.body.departurePort).toBe("Miami");
  });
});
