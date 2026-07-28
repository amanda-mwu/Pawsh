import postgres from "postgres";
import type { Config } from "../config.js";

export type Database = ReturnType<typeof postgres>;

export function createDatabase(config: Pick<Config, "DATABASE_URL">): Database {
  return postgres(config.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    transform: postgres.camel
  });
}
