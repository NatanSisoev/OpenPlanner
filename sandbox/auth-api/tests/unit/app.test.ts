import { createApp } from "../../src/app.js";

describe("unit: app factory", () => {
  it("creates an Express app", () => {
    const app = createApp();
    expect(app).toBeDefined();
    expect(typeof app.use).toBe("function");
  });
});
