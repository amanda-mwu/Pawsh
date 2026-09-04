import postgres from "postgres";
import { applyMigrations } from "../../scripts/apply-migrations.js";
import {
  claimExclusiveRun, createRunOwnership, describeHolder, heartbeatIntervalMs,
  lockPollIntervalMs, runLockName, type LockHolder, type RunLockGateway, type RunOwnership
} from "./test-run-lock.js";

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
  /** Which run instance holds the lock, as recorded on the lock-holding session itself. */
  ownership: RunOwnership;
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
 * The gateway the claim protocol in `test-run-lock.ts` runs against.
 *
 * THE LOCK IS TAKEN ON THE MAINTENANCE DATABASE, NOT THE TARGET. PostgreSQL advisory locks are
 * scoped to one database, and the target is a database this run may be about to drop - a lock
 * held inside it would be unavailable before the database exists and destroyed along with it.
 * That is also why `pg_stat_activity` below is read from the same connection: the holder's
 * session is attached here too.
 *
 * THE LOCK IS ADDRESSED AS ITSELF, NOT LOOKED UP BY NAME. `pg_locks` splits a one-argument
 * advisory key into `classid` (the high 32 bits) and `objid` (the low 32), so the holder is found
 * by taking the same `hashtextextended` value apart the same way. Nothing else in this repository
 * uses that key, so any session holding it is one of ours.
 *
 * THE TIMESTAMPS ARE COMPARED AS TEXT. `state_change` has microsecond resolution and a JavaScript
 * `Date` has millisecond, so a fence that round-tripped it through one would silently never
 * match - which would turn "refuse to kill a holder that came back to life" into "never able to
 * reclaim anything at all".
 */
export function runLockGateway(admin: Maintenance): RunLockGateway {
  const key = admin`hashtextextended(${runLockName},0)`;
  return {
    async tryAcquire() {
      const [claimed] = await admin<{ locked: boolean }[]>`
        select pg_try_advisory_lock(${key}) as locked
      `;
      return claimed?.locked === true;
    },
    async readHolder() {
      const [holder] = await admin<LockHolder[]>`
        with lock_key as (select ${key} as value)
        select activity.pid as backend_pid, activity.application_name, activity.state,
          (extract(epoch from (now() - greatest(activity.state_change, activity.query_start,
            activity.backend_start))) * 1000)::float8 as idle_ms,
          activity.backend_start::text as backend_start_text,
          activity.state_change::text as state_change_text
        from pg_locks lock
        join pg_stat_activity activity on activity.pid = lock.pid, lock_key
        where lock.locktype='advisory' and lock.granted and lock.objsubid=1
          and lock.classid = ((lock_key.value >> 32) & 4294967295)::oid
          and lock.objid = (lock_key.value & 4294967295)::oid
        limit 1
      `;
      return holder ?? null;
    },
    async reclaim(holder) {
      // Fenced on everything that could have changed since it was observed: the same backend
      // (`backend_start` identifies the session, so a recycled pid is a different session), the
      // same recorded owner, still idle, still not having done anything, and still holding this
      // lock. A holder that woke up in between fails the fence and is left alone, which is what
      // makes "one run cannot steal a live lock" true even under a race.
      const [terminated] = await admin<{ ended: boolean }[]>`
        with lock_key as (select ${key} as value)
        select pg_terminate_backend(activity.pid) as ended
        from pg_locks lock
        join pg_stat_activity activity on activity.pid = lock.pid, lock_key
        where lock.locktype='advisory' and lock.granted and lock.objsubid=1
          and lock.classid = ((lock_key.value >> 32) & 4294967295)::oid
          and lock.objid = (lock_key.value & 4294967295)::oid
          and activity.pid = ${holder.backendPid}
          and activity.backend_start::text = ${holder.backendStartText}
          and activity.state_change::text = ${holder.stateChangeText}
          and activity.state = 'idle'
          and activity.application_name is not distinct from ${holder.applicationName}
      `;
      return terminated?.ended === true;
    }
  };
}

/**
 * Keeps proving the owner is alive.
 *
 * This is the whole liveness signal, and it is deliberately the cheapest possible statement on the
 * connection that already holds the lock: running it moves `state_change`, which is the only thing
 * a waiter on another machine can see. `unref` so a run that has finished its work is never held
 * open by its own heartbeat.
 */
function startHeartbeat(admin: Maintenance): () => void {
  const timer = setInterval(() => {
    // A failed heartbeat is not a reason to fail the run: if the connection has genuinely gone,
    // the lock has gone with it and the next waiter is entitled to the database anyway.
    void admin`select 1`.catch(() => {});
  }, heartbeatIntervalMs);
  timer.unref();
  return () => { clearInterval(timer); };
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
  const ownership = createRunOwnership();
  // The ownership token IS the `application_name`, so the record exists exactly as long as the
  // session that holds the lock and can never be left behind by it.
  //  because  selects real columns rather than aliases, and the
  // typed `LockHolder` it fills in would otherwise be an object of undefined fields that reads
  // as "no owner recorded" for every holder.
  const admin = postgres(maintenanceUrl(mode.url), {
    max: 1, transform: postgres.camel, connection: { application_name: ownership.token }
  });
  let stopHeartbeat: (() => void) | null = null;
  let releaseOnSignal: (() => void) | null = null;
  const release = async (): Promise<void> => {
    stopHeartbeat?.();
    stopHeartbeat = null;
    releaseOnSignal?.();
    releaseOnSignal = null;
    await admin.end();
  };
  try {
    const claim = await claimExclusiveRun(runLockGateway(admin), {
      onReclaim: (holder, reason) => {
        console.warn(
          `[pawsh] Reclaimed the database run lock from a dead owner: ${reason}.` +
          ` It was ${describeHolder(holder)}.`
        );
      }
    });
    if (claim.reclaimed === null && claim.waitedMs > lockPollIntervalMs) {
      console.info(`[pawsh] Waited ${Math.round(claim.waitedMs / 1000)}s for another database run to finish.`);
    }
    stopHeartbeat = startHeartbeat(admin);
    releaseOnSignal = installSignalRelease(release);
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
      ownership,
      // Ending the connection releases the session-scoped advisory lock. That covers a clean exit
      // and a crash that actually closes the socket; the heartbeat above is what covers the case
      // it does not - a killed run whose connection survives it.
      release
    };
  } catch (error) {
    await release();
    throw error;
  }
}

/**
 * Gives back the lock on a handled termination, instead of leaving the server to notice.
 *
 * `SIGINT` and `SIGTERM` would close the socket on their own once Node exits, but only after the
 * default handling gets there, and a run interrupted at the wrong moment is exactly when somebody
 * is about to start another. The handler re-raises rather than swallowing, so Ctrl-C still means
 * what it means. It cannot help with `SIGKILL` - nothing running in this process can - which is
 * why the heartbeat exists rather than this.
 */
function installSignalRelease(release: () => Promise<void>): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  const remove = (): void => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };
  for (const signal of signals) {
    const handler = (): void => {
      remove();
      void release().catch(() => {}).finally(() => { process.kill(process.pid, signal); });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return remove;
}
