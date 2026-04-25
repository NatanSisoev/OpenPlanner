import request from "supertest";
import { createApp } from "../../src/app.js";

describe("integration: /api/health method handling", () => {
  it("rejects non-GET with 404 or 405", async () => {
    const res = await request(createApp()).post("/api/health");
    expect([404, 405]).toContain(res.status);
  });
});
