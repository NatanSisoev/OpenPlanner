import { apiRouter } from "../../src/api/router.js";

describe("unit: API router", () => {
  it("is an Express-style router with HTTP helpers", () => {
    expect(typeof apiRouter.get).toBe("function");
    expect(typeof apiRouter.use).toBe("function");
  });
});
