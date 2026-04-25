/**
 * Creates database `planstack` (via MONGODB_DB) and collection `plan` if missing.
 * Requires MONGODB_URI in repo root `.env`. If connection fails with TLS/internal
 * errors, add your IP (or 0.0.0.0/0 for hackathon) under Atlas → Network Access.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const envPath = join(repoRoot, ".env");

if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB?.trim() || "planstack";
const collectionName = "plan";

if (!uri) {
  console.error("Missing MONGODB_URI (set in repo root .env).");
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });

try {
  await client.connect();
  const db = client.db(dbName);
  const names = await db.listCollections({ name: collectionName }).toArray();
  if (names.length > 0) {
    console.log(`Collection "${collectionName}" already exists in database "${dbName}".`);
  } else {
    await db.createCollection(collectionName);
    console.log(`Created collection "${collectionName}" in database "${dbName}".`);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const isTls = /tlsv1 alert internal|ERR_SSL_TLSV1_ALERT_INTERNAL|SSL alert number 80/i.test(msg);
  console.error("MongoDB connection failed:", msg);
  if (isTls || /MongoServerSelectionError/i.test(msg)) {
    console.error(`
Likely fixes (Atlas):
  1. Network Access: add your current public IP, or temporarily 0.0.0.0/0 for a hackathon.
  2. Database Access: confirm the DB user/password matches this URI (reset password if unsure).
  3. Use the exact SRV string from Atlas → Connect → Drivers (includes /dbname and recommended query params).
  4. If on VPN/corporate Wi‑Fi, try another network or disable intercepting proxies.

If mongosh works with the same URI but Node fails, try Node 20 LTS.
`);
  }
  process.exit(1);
} finally {
  await client.close().catch(() => {});
}
