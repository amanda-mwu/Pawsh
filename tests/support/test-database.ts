import postgres from "postgres";
import { applyMigrations } from "../../scripts/apply-migrations.js";

export const databaseTestSwitch = "PAWSH_DATABASE_TESTS";
export const explicitDatabaseUrlVariable = "PAWSH_TEST_DATABASE_URL";

/**
 * Database suites must never look green while doing nothing. Exactly one of these
 * states is reported before the database project runs:
 *
 *   executed    an isolated, migrated test database was resolved and will be used
 *   excluded    an operator explicitly opted out with PAWSH_DATABASE_TESTS=off
 *   unavailable prerequisites are missing; the run fails instead of skipping
 */
export type DatabaseTestMode =
  | { state: "executed"; url: string; database: string; source: string }
  | { state: "excluded"; reason: string }
  | { state: "unavailable"; reason: string };

const isolatedDatabaseSuffix = "_vitest";

function describeUrl(url: string, source: string): DatabaseTestMode {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { state: "unavailable", reason: `${source} is not a valid PostgreSQL URL` };
  }
  const database = parsed.pathname.slice(1);
  if (!database) return { state: "unavailable", reason: `${source} does not name a database` };
  return { state: "executed", url: parsed.toString(), database, source };
}

/**
 * Derives a dedicated test database on the same server as DATABASE_URL rather than
 * reusing it, so a developer's working database is structurally never the target.
 */
export function isolatedDatabaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const database = parsed.pathname.slice(1);
  if (!database.endsWith(isolatedDatabaseSuffix)) {
    parsed.pathname = `/${database}${isolatedDatabaseSuffix}`;
  }
  return parsed.toString();
}

export function resolveDatabaseTestMode(env: NodeJS.ProcessEnv = process.env): DatabaseTestMode {
  if ((env[databaseTestSwitch] ?? "").trim().toLowerCase() === "off") {
    return { state: "excluded", reason: `${databaseTestSwitch}=off` };
  }
  const explicit = env[explicitDatabaseUrlVariable]?.trim();
  if (explicit) return describeUrl(explicit, explicitDatabaseUrlVariable);
  const base = env.DATABASE_URL?.trim();
  if (!base) {
    return {
      state: "unavailable",
      reason: `Neither ${explicitDatabaseUrlVariable} nor DATABASE_URL is set`
    };
  }
  try {
    return describeUrl(isolatedDatabaseUrl(base), `DATABASE_URL (isolated as ${isolatedDatabaseSuffix})`);
  } catch {
    return { state: "unavailable", reason: "DATABASE_URL is not a valid PostgreSQL URL" };
  }
}

export function prerequisiteFailureMessage(reason: string): string {
  return [
    "",
    "Pawsh database tests could not run: PREREQUISITE FAILURE.",
    `  ${reason}`,
    "",
    "  Point DATABASE_URL at a reachable PostgreSQL server; the harness provisions and",
    `  migrates an isolated "<database>${isolatedDatabaseSuffix}" companion database and never`,
    "  touches the database named in DATABASE_URL.",
    "",
    `    docker compose up -d postgres`,
    `    DATABASE_URL=postgres://pawsh:pawsh-local-only@127.0.0.1:55432/pawsh npm run test:db`,
    "",
    `  Set ${explicitDatabaseUrlVariable} to target a specific database instead, or`,
    `  ${databaseTestSwitch}=off to record an explicit, visible exclusion.`,
    ""
  ].join("\n");
}

async function ensureDatabaseExists(url: string): Promise<void> {
  const target = new URL(url);
  const database = target.pathname.slice(1);
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const sql = postgres(maintenance.toString(), { max: 1 });
  try {
    const [existing] = await sql<{ present: number }[]>`
      select 1 as present from pg_database where datname=${database}
    `;
    if (existing) return;
    // Concurrent runners can race here; a duplicate is success, not a failure.
    await sql.unsafe(`create database "${database.replaceAll('"', '""')}"`);
  } catch (error) {
    if ((error as { code?: string }).code !== "42P04") throw error;
  } finally {
    await sql.end();
  }
}

/** Creates the isolated database when missing and brings it to the latest migration. */
export async function provisionTestDatabase(
  mode: Extract<DatabaseTestMode, { state: "executed" }>
): Promise<{ applied: string[] }> {
  await ensureDatabaseExists(mode.url);
  const sql = postgres(mode.url, { max: 1 });
  try {
    // Serialize concurrent provisioning so parallel workers cannot apply the same file twice.
    await sql`select pg_advisory_lock(hashtextextended('pawsh:test-migrations',0))`;
    try {
      return { applied: await applyMigrations(sql) };
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended('pawsh:test-migrations',0))`;
    }
  } finally {
    await sql.end();
  }
}
