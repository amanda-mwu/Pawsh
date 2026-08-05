import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const url = new URL(databaseUrl);
const database = decodeURIComponent(url.pathname.slice(1));
if (
  !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
  !["pawsh", "pawsh_dev"].includes(database)
) {
  throw new Error("Local seed requires loopback database pawsh or pawsh_dev");
}
if (process.env.NODE_ENV === "production") throw new Error("Local seed is disabled in production");
const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-qa.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PAWSH_ALLOW_QA_SEED: "true",
    PAWSH_QA_DATABASE_MARKER: database,
    PAWSH_QA_PASSWORD: process.env.PAWSH_LOCAL_SEED_PASSWORD ?? "pawsh-local-only",
    QA_ANCHOR_DATE: process.env.QA_ANCHOR_DATE ?? "2026-08-04T15:00:00.000Z"
  }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
