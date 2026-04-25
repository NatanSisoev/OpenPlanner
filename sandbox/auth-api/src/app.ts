import express from "express";
import { apiRouter } from "./api/router.js";

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  return app;
}
