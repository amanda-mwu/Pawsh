import postgres from "postgres";
import type { Config } from "../config.js";

export type Database = ReturnType<typeof postgres>;
/** Anything that can run a statement: the pool, or a transaction taken from it. */
export type SqlExecutor = Database | postgres.TransactionSql;

/**
 * Names the tenant for the rest of this transaction, which is what every `tenant_isolation`
 * policy in the schema reads. Local to the transaction, so it can never leak onto the next
 * checkout of a pooled connection.
 */
export async function setTenant(tx: postgres.TransactionSql, businessId: string): Promise<void> {
  await tx`select set_config('app.business_id', ${businessId}, true)`;
}

export function createDatabase(config: Pick<Config, "DATABASE_URL">): Database {
  return postgres(config.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    transform: postgres.camel
  });
}
