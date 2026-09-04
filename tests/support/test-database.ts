import postgres from "postgres";
import { applyMigrations } from "../../scripts/apply-migrations.js";

export const databaseTestSwitch = "PAWSH_DATABASE_TESTS";
export const explicitDatabaseUrlVariable = "PAWSH_TEST_DATABASE_URL";
export const databaseResetSwitch = "PAWSH_TEST_DATABASE_RESET";

/**
 * Database suites must never look green while doing nothing. Exactly one of these
 * states is reported before the database project runs:
 *
 *   executed    an isolated, migrated test database was resolved and will be used
 *   excluded    an operator explicitly opted out with PAWSH_DATABASE_TESTS=off
 *   unavailable prerequisites are missing; the run fails instead of skipping
 */
export type DatabaseTestMode =
  | {
      state: "executed";
      url: string;
      database: string;
      source: string;
      /**
       * Whether this database is one the harness is entitled to destroy, which is decided by
       * its NAME and nothing else. A derived target always is - the harness invented the name.
       * An operator-supplied one is only if they opted into the convention by using it.
       */
      disposable: boolean;
    }
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
  return {
    state: "executed",
    url: parsed.toString(),
    database,
    source,
    disposable: database.endsWith(isolatedDatabaseSuffix)
  };
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

/**
 * How a run started, which is a fact the run has to report rather than assume.
 *
 * WHY THIS EXISTS AT ALL. The harness used to create the isolated database once and then bring
 * it forward with `applyMigrations` on every subsequent run, and nothing ever removed a row. A
 * few months of that left hundreds of businesses, thousands of pets and - the case that actually
 * bit - Square connections and webhook events from earlier runs still sitting in the tables the
 * worker suites claim from. Those rows are not inert. They are eligible work: a `connected`
 * connection whose `next_refresh_at` fell into the past is claimed by the very tick under test,
 * and an assertion that said "this tick refreshed exactly the connection I just made" had to be
 * loosened to "at least one" to keep passing. That is a test being edited to agree with its
 * environment, and it is how a real starvation defect stayed invisible.
 *
 * SO A RUN STARTS FROM AN EMPTY DATABASE, NOT A TIDIED ONE. Deleting known tables afterwards
 * would be a list somebody has to remember to extend, and it cannot distinguish a row a
 * migration seeded from a row a test left behind. Dropping and recreating the database has
 * neither problem, costs about a second for the whole chain, and has a second payoff: every
 * authoritative database run now applies all migrations to an empty database, so the chain is
 * exercised from 0001 on every run rather than only on a new machine.
 */
export interface TestDatabaseProvisioning {
  /** `reset` means the run begins empty; `reused` means it does not, and why. */
  start: "reset" | "reused";
  reason?: string;
  applied: string[];
  /**
   * Ends the run's exclusive claim on the isolated database. Call it once the suites are done.
   *
   * The claim is held for the WHOLE RUN, not just while provisioning, and that is a direct
   * consequence of resetting. Two concurrent runs against one shared database used to merely
   * confuse each other's data; a reset would let the second one drop the database out from under
   * the first, mid-suite. Holding the lock until teardown turns that into the second run waiting,
   * which is what "isolated" has to mean once the harness is allowed to destroy anything.
   */
  release(): Promise<void>;
}

/**
 * Serialises provisioning between concurrent runners.
 *
 * Taken on the MAINTENANCE database, not on the target. PostgreSQL advisory locks are scoped to
 * one database, and the target is a database this function may be about to drop - a lock held
 * inside it would be both unavailable when the database does not exist and destroyed by the drop.
 */
const provisionLockName = "pawsh:test-migrations";

/** How long a second run waits for the first to finish before saying so. */
export const exclusiveRunWaitMs = 10 * 60_000;
const exclusiveRunPollMs = 500;

/**
 * Waits until this process is the only one entitled to the isolated database.
 *
 * Polled with `pg_try_advisory_lock` rather than blocking in `pg_advisory_lock`, purely so the
 * wait can end with a sentence somebody can act on instead of a run that appears to hang.
 */
async function claimExclusiveRun(admin: Maintenance): Promise<void> {
  const deadline = Date.now() + exclusiveRunWaitMs;
  for (;;) {
    const [claimed] = await admin<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtextextended(${provisionLockName},0)) as locked
    `;
    if (claimed?.locked) return;
    if (Date.now() >= deadline) {
      throw new Error(
        "Pawsh database tests could not start: another database run holds the isolated database.\n"
        + "  Authoritative database runs are serialised because each one resets that database,\n"
        + "  so starting a second would destroy the first run's schema and fixtures mid-suite.\n"
        + "  Wait for the other run to finish, or stop it, and try again."
      );
    }
    await new Promise((resolve) => { setTimeout(resolve, exclusiveRunPollMs); });
  }
}

function maintenanceUrl(url: string): string {
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  return maintenance.toString();
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

type Maintenance = ReturnType<typeof postgres>;

async function ensureDatabaseExists(admin: Maintenance, database: string): Promise<void> {
  const [existing] = await admin<{ present: number }[]>`
    select 1 as present from pg_database where datname=${database}
  `;
  if (existing) return;
  try {
    await admin.unsafe(`create database ${quoteIdentifier(database)}`);
  } catch (error) {
    // Concurrent runners can race here; a duplicate is success, not a failure.
    if ((error as { code?: string }).code !== "42P04") throw error;
  }
}

/**
 * Replaces the isolated database with an empty one.
 *
 * `with (force)` terminates any session still attached. That is the correct behaviour for a
 * database whose name the harness derived and whose only purpose is to hold one run's fixtures;
 * without it a forgotten `psql` window makes the reset fail rather than the connection close. It
 * is also why `disposable` gates this: the check is on the NAME, so an operator's own database
 * can never be reached by it however the switches are set.
 */
async function recreateDatabase(admin: Maintenance, database: string): Promise<void> {
  const quoted = quoteIdentifier(database);
  await admin.unsafe(`drop database if exists ${quoted} with (force)`);
  await admin.unsafe(`create database ${quoted}`);
}

function resolveStart(
  mode: Extract<DatabaseTestMode, { state: "executed" }>,
  env: NodeJS.ProcessEnv
): { reset: boolean; reason?: string } {
  if ((env[databaseResetSwitch] ?? "").trim().toLowerCase() === "off") {
    return { reset: false, reason: `${databaseResetSwitch}=off` };
  }
  if (!mode.disposable) {
    return {
      reset: false,
      reason: `${mode.source} names "${mode.database}", which does not end in `
        + `"${isolatedDatabaseSuffix}", so the harness will not drop it`
    };
  }
  return { reset: true };
}

/**
 * Brings the isolated database to the state the run is entitled to assume.
 *
 * By default that state is "empty, then fully migrated". `PAWSH_TEST_DATABASE_RESET=off` trades
 * it for a faster inner loop, and an operator-named database is never dropped; both cases are
 * reported by the caller rather than being silently indistinguishable from a clean run.
 */
export async function provisionTestDatabase(
  mode: Extract<DatabaseTestMode, { state: "executed" }>,
  env: NodeJS.ProcessEnv = process.env
): Promise<TestDatabaseProvisioning> {
  const start = resolveStart(mode, env);
  const admin = postgres(maintenanceUrl(mode.url), { max: 1 });
  try {
    await claimExclusiveRun(admin);
    if (start.reset) await recreateDatabase(admin, mode.database);
    else await ensureDatabaseExists(admin, mode.database);
    const sql = postgres(mode.url, { max: 1 });
    let applied: string[];
    try {
      applied = await applyMigrations(sql);
    } finally {
      await sql.end();
    }
    return {
      start: start.reset ? "reset" : "reused",
      ...(start.reason === undefined ? {} : { reason: start.reason }),
      applied,
      // Ending the connection releases the session-scoped advisory lock, which is also why an
      // abandoned or crashed run cannot leave the claim stuck: the server drops it with the
      // session.
      release: () => admin.end()
    };
  } catch (error) {
    await admin.end();
    throw error;
  }
}
