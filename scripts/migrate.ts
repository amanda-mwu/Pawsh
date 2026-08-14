import postgres from "postgres";
import { loadConfig } from "../src/config.js";
import { applyMigrations, seedBusinessCatalogs } from "./apply-migrations.js";

const config = loadConfig();
const sql = postgres(config.DATABASE_URL, { max: 1 });

try {
  await applyMigrations(sql, { log: (message) => console.log(message) });
  await seedBusinessCatalogs(sql);
} finally {
  await sql.end();
}
