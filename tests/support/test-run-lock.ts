/**
 * Which run owns the isolated test database, and whether that owner is still alive.
 *
 * WHY THIS FILE EXISTS. Authoritative database runs are serialised, because each one drops and
 * recreates the isolated database and a second run starting mid-suite would destroy the first
 * one's schema and fixtures. The serialisation itself is a PostgreSQL session-scoped advisory
 * lock, which is the right primitive: it is atomic, it needs no table, and the server releases it
 * the instant the owning session goes away.
 *
 * THE DEFECT THAT PROMPTED THIS. "The instant the owning session goes away" is not the same as
 * "the instant the run dies". A session advisory lock's liveness is the liveness of a CONNECTION,
 * and a killed Node process can leave its socket open: the backend sits `idle` and holds the lock,
 * the server has no reason to notice, and TCP keepalives will not close it for hours. The next run
 * then waited its whole timeout and reported a concurrent run that did not exist, and recovery
 * meant finding the backend in `pg_locks` by hand and calling `pg_terminate_backend`.
 *
 * SO THE LOCK CANNOT ANSWER THE QUESTION ON ITS OWN, AND NEEDS AN OWNERSHIP RECORD BESIDE IT.
 * That record is deliberately not a table and not a second lock - a second mechanism would have
 * its own staleness problem, one layer further out. It is `application_name` on the very session
 * that holds the lock, which means the record is created and destroyed at exactly the moments the
 * lock is, can never outlive it, can never disagree with it, and is readable by any waiter through
 * `pg_stat_activity` without touching a schema.
 *
 * LIVENESS IS THE SESSION'S OWN ACTIVITY, NOT A PROCESS CHECK. The owner runs a small heartbeat on
 * the lock-holding connection, so a living run keeps `state_change` moving. A waiter therefore
 * decides staleness from what the SERVER can see about that session - is it idle, and for how
 * long - which needs no access to the owner's host and works whether or not the two runs are even
 * on the same machine.
 *
 * THE PID IS REPORTED AND NEVER TRUSTED. `classifyHolder` does not read it, so a recycled PID
 * cannot make a dead owner look alive: validity is decided by session activity alone, and the
 * `runId` in the token is what distinguishes one run instance from another. The PID and start time
 * are carried so that a refusal can name something an operator can actually go and look at.
 */

export const runLockName = "pawsh:test-migrations";

/** How often the owner proves it is still there, and how long silence is tolerated. */
export const heartbeatIntervalMs = 5_000;
/**
 * Nine missed heartbeats. Long enough that a garbage collection pause, a slow migration or a
 * suspended debugger is never mistaken for a dead run, short enough that a killed run costs the
 * next one one poll rather than ten minutes.
 */
export const staleOwnerMs = 45_000;
export const lockPollIntervalMs = 500;
/** How long a run waits for a LIVE owner before it gives up and says who has it. */
export const exclusiveRunWaitMs = 10 * 60_000;

/** The `pawsh-qa` prefix is what makes a holder recognisably ours, and never anybody else's. */
const tokenPrefix = "pawsh-qa";

export interface RunOwnership {
  /** Distinguishes this run instance from every other. The only identity that decides ownership. */
  runId: string;
  /** Reported so a refusal names something real. Never consulted when deciding liveness. */
  pid: number;
  startedAt: Date;
  /** The `application_name` the lock-holding session carries. */
  token: string;
}

/**
 * `application_name` is truncated to 63 bytes by the server, so the token is built to fit inside
 * that with room to spare rather than relying on nobody noticing the truncation.
 */
export function createRunOwnership(
  input: { runId?: string; pid?: number; startedAt?: Date } = {}
): RunOwnership {
  const runId = input.runId ?? crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const pid = input.pid ?? process.pid;
  const startedAt = input.startedAt ?? new Date();
  return {
    runId,
    pid,
    startedAt,
    token: `${tokenPrefix}:${runId}:${pid}:${Math.floor(startedAt.getTime() / 1000)}`
  };
}

export function parseRunOwnership(applicationName: string | null): RunOwnership | null {
  if (!applicationName) return null;
  const parts = applicationName.split(":");
  if (parts.length !== 4 || parts[0] !== tokenPrefix) return null;
  const pid = Number(parts[2]);
  const seconds = Number(parts[3]);
  if (!parts[1] || !Number.isInteger(pid) || !Number.isInteger(seconds)) return null;
  return {
    runId: parts[1], pid, startedAt: new Date(seconds * 1000), token: applicationName
  };
}

/** What the server can see about the session currently holding the lock. */
export interface LockHolder {
  backendPid: number;
  applicationName: string | null;
  state: string | null;
  /** Milliseconds since this session last did anything, measured on the SERVER's clock. */
  idleMs: number | null;
  /** Session identity and last-activity instant, as text, so a fence compares them exactly. */
  backendStartText: string | null;
  stateChangeText: string | null;
}

export type HolderVerdict =
  | { holder: "live"; reason: string }
  | { holder: "stale"; reason: string };

/**
 * Whether the run holding the lock is still running.
 *
 * Conservative in one direction on purpose: anything this cannot positively establish as dead is
 * treated as alive, because refusing to start is recoverable and stealing a live run's database
 * out from under it is not.
 */
export function classifyHolder(
  holder: LockHolder,
  options: { staleAfterMs?: number } = {}
): HolderVerdict {
  const staleAfterMs = options.staleAfterMs ?? staleOwnerMs;
  const owner = parseRunOwnership(holder.applicationName);
  // A session that is running a statement, or sitting inside a transaction, is doing something.
  // Only a plainly idle one can be dead without the server knowing.
  if (holder.state !== "idle") {
    return { holder: "live", reason: `its session is ${holder.state ?? "in an unreported state"}` };
  }
  if (holder.idleMs === null) {
    return { holder: "live", reason: "the server did not report how long its session has been idle" };
  }
  if (holder.idleMs < staleAfterMs) {
    return {
      holder: "live",
      reason: `its session was last active ${Math.round(holder.idleMs / 1000)}s ago, within the `
        + `${Math.round(staleAfterMs / 1000)}s a running owner is allowed to be quiet for`
    };
  }
  return {
    holder: "stale",
    reason: owner
      ? `run ${owner.runId} stopped heartbeating ${Math.round(holder.idleMs / 1000)}s ago`
      : `an older runner that recorded no ownership has been idle ${Math.round(holder.idleMs / 1000)}s`
  };
}

/** One line naming the holder, for a message somebody has to act on. */
export function describeHolder(holder: LockHolder): string {
  const owner = parseRunOwnership(holder.applicationName);
  const identity = owner
    ? `run ${owner.runId}, started by process ${owner.pid} at ${owner.startedAt.toISOString()}`
    : `an unidentified runner (application_name ${holder.applicationName
      ? JSON.stringify(holder.applicationName) : "not set"})`;
  const idle = holder.idleMs === null
    ? "unknown" : `${Math.round(holder.idleMs / 1000)}s`;
  return `${identity}; PostgreSQL backend pid ${holder.backendPid}, session ${holder.state ?? "?"}`
    + ` for ${idle}, connected at ${holder.backendStartText ?? "an unreported time"}`;
}

/**
 * What a refused run prints.
 *
 * It names the owner and it names the manual escape hatch, because the whole reason this exists
 * is that somebody had to work out `pg_locks` and `pg_terminate_backend` unaided while a run was
 * blocked.
 */
export function blockedRunMessage(holder: LockHolder | null, waitedMs: number): string {
  const waited = Math.round(waitedMs / 1000);
  return [
    "",
    "Pawsh database tests could not start: another database run holds the isolated database.",
    "  Authoritative database runs are serialised because each one resets that database, so",
    "  starting a second would destroy the first run's schema and fixtures mid-suite.",
    "",
    holder ? `  Held by: ${describeHolder(holder)}` : "  Held by: a session that has since gone away",
    `  Waited:  ${waited}s. A holder that stops heartbeating for `
      + `${Math.round(staleOwnerMs / 1000)}s is reclaimed automatically, so this one still looks alive.`,
    "",
    "  If you are certain that run is gone, release it with:",
    holder
      ? `    select pg_terminate_backend(${holder.backendPid});`
      : "    select pg_terminate_backend(pid) from pg_locks where locktype='advisory';",
    ""
  ].join("\n");
}

/** The three things a claim needs from the database, kept behind an interface so the protocol
 * above them can be exercised without one. */
export interface RunLockGateway {
  /** `pg_try_advisory_lock`: true when this session now holds the lock. */
  tryAcquire(): Promise<boolean>;
  /** Who holds it, or null if nobody does any more. */
  readHolder(): Promise<LockHolder | null>;
  /**
   * Terminates a holder, FENCED on it still being the same idle session we looked at. Returns
   * false when the fence rejected it, which is how a holder that came back to life between the
   * two statements survives.
   */
  reclaim(holder: LockHolder): Promise<boolean>;
}

export interface ClaimOutcome {
  /** The dead owner this run cleared out of the way, when there was one. */
  reclaimed: LockHolder | null;
  waitedMs: number;
}

/**
 * Waits until this session is the only one entitled to the isolated database.
 *
 * Polled with `pg_try_advisory_lock` rather than blocking in `pg_advisory_lock`, because a
 * blocking wait can neither notice that the holder has died nor end with a sentence somebody can
 * act on.
 *
 * A reclaim retries the acquisition IMMEDIATELY rather than waiting out another poll, and it is
 * safe for two waiters to reach it at once: terminating an already-terminated backend does
 * nothing, and whichever of them then wins `pg_try_advisory_lock` wins it exactly once.
 */
export async function claimExclusiveRun(
  gateway: RunLockGateway,
  options: {
    waitMs?: number;
    pollMs?: number;
    staleAfterMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onReclaim?: (holder: LockHolder, reason: string) => void;
  } = {}
): Promise<ClaimOutcome> {
  const waitMs = options.waitMs ?? exclusiveRunWaitMs;
  const pollMs = options.pollMs ?? lockPollIntervalMs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const startedAt = now();
  const deadline = startedAt + waitMs;
  let reclaimed: LockHolder | null = null;
  for (;;) {
    if (await gateway.tryAcquire()) return { reclaimed, waitedMs: now() - startedAt };
    const holder = await gateway.readHolder();
    if (holder) {
      const verdict = classifyHolder(
        holder,
        options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }
      );
      if (verdict.holder === "stale" && await gateway.reclaim(holder)) {
        reclaimed = holder;
        options.onReclaim?.(holder, verdict.reason);
        continue;
      }
    }
    if (now() >= deadline) throw new Error(blockedRunMessage(holder, now() - startedAt));
    await sleep(pollMs);
  }
}
