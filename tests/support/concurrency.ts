import type { Database, SqlExecutor } from "../../src/db/client.js";

/**
 * A rendezvous for tests that have to pin an interleaving rather than hope for one.
 *
 * A race test that fires two requests and hopes they collide proves nothing when they do not, and
 * a race test that sleeps proves nothing either way. What both are reaching for is a barrier: hold
 * a row lock, let the transaction under test run until it is demonstrably waiting on that lock,
 * and only then do the work whose effect it must not lose. `pg_blocking_pids` is that barrier and
 * it is exact - it names the backends waiting on THIS backend, so the wait ends on the observed
 * fact rather than on a duration somebody guessed.
 *
 * The database project runs its files serially (`fileParallelism: false` in `vitest.config.ts`),
 * so the only backends in play are this test's own.
 */
export async function waitUntilBlockedBy(
  db: Database,
  input: { pid: number; count?: number; timeoutMs?: number }
): Promise<void> {
  const wanted = input.count ?? 1;
  const timeoutMs = input.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // RECURSIVE, because a lock queue is a chain rather than a star. The first racer waits on
    // this backend's row lock; the second waits behind the first, and `pg_blocking_pids` names
    // the racer ahead of it rather than the backend at the head of the queue. Counting only the
    // direct waiters would see one when two are held up, and the barrier would release early.
    const [row] = await db<{ waiting: number }[]>`
      with recursive waits as (
        select pid, unnest(pg_blocking_pids(pid)) as blocker from pg_stat_activity
        where wait_event_type='Lock' and datname=current_database()
      ), chain as (
        select pid from waits where blocker=${input.pid}
        union
        select waits.pid from waits join chain on waits.blocker=chain.pid
      )
      select count(distinct pid)::int as waiting from chain
    `;
    if ((row?.waiting ?? 0) >= wanted) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Expected ${wanted} transaction(s) blocked on backend ${input.pid} within ${timeoutMs}ms, `
        + `saw ${row?.waiting ?? 0}. The interleaving this test depends on did not happen.`
      );
    }
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

/** The backend id of the connection a transaction is running on. */
export async function backendPid(tx: SqlExecutor): Promise<number> {
  const [row] = await tx<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
  return row!.pid;
}
