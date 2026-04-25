import request from "supertest";
import { createApp } from "../../src/app.js";

describe("e2e: API smoke", () => {
  it("can query health in sequence", async () => {
    const app = createApp();
    const first = await request(app).get("/api/health");
    expect(first.status).toBe(200);
    const second = await request(app).get("/api/health");
    expect(second.body).toEqual({ ok: true });
  });
});
