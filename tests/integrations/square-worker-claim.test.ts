import { describe, expect, it } from "vitest";
import { claimStatements, recordingDatabase } from "../support/recording-database.js";
import {
  connectionRefreshBatch, connectionRefreshHealthyReserve, refreshDueConnections
} from "../../src/integrations/square/oauth.js";
import {
  maxWebhookAttempts, processSquareWebhooks, webhookArrivalReserve, webhookClaimBatch
} from "../../src/integrations/square/webhooks.js";

/**
 * WHAT THIS FILE IS FOR, AND WHAT IT IS NOT.
 *
 * Both Square worker ticks claim rows with `for update skip locked` and hand them to code that
 * talks to Square. The property this file pins is the CLAIM POLICY: which rows a tick is allowed
 * to see, in what order, and how much of the budget each lane may take. That policy is the whole
 * of the starvation fix, it is expressible as the statements the tick issues, and it needs no
 * server to check - so it is checked here, on every `npm test`, rather than only where a
 * PostgreSQL instance happens to be available.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM TO COVER: that `skip locked` actually makes two concurrent
 * workers take disjoint rows, that the ten-minute fence actually excludes a claimed row from the
 * next statement, or that the plan uses `square_webhook_pending`. Those are properties of
 * PostgreSQL, not of this code, and asserting them against a fake would be asserting the fake.
 * They belong to the database suite.
 *
 * THE DEFECT THIS EXISTS TO STOP COMING BACK. The webhook drain claimed globally, oldest-first,
 * `limit 25`. Arrival order never changes, so once more than twenty-five retryable rows existed
 * the newest event was not reached until enough of the backlog had died - and a `payment.updated`
 * notification a salon is waiting on sat behind events that were failing precisely because
 * nothing about them was going to change. A single claim ordered by `received_at` is therefore
 * the shape that must never come back, and the assertions below are written to say so directly.
 */

const claims = claimStatements;

function webhookRow(overrides: Partial<{ id: string; attempts: number; payloadText: string }> = {}) {
  return {
    id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
    eventId: `evt-${overrides.id ?? "1"}`,
    merchantId: "MERCHANT",
    eventType: "inventory.count.updated",
    payloadText: overrides.payloadText ?? "{}",
    attempts: overrides.attempts ?? 1
  };
}

const workerDependencies = {
  environment: "sandbox",
  keyring: { open: () => "plain-refresh", seal: () => ({ value: "sealed", keyVersion: 3 }) },
  client: { refreshAccessToken: () => { throw new Error("Square is unreachable"); } }
} as never;

describe("the Square webhook drain's claim policy", () => {
  it("takes a reserved lane of first attempts before it takes anything else", async () => {
    const { db, executed } = recordingDatabase((statement) =>
      (statement.text.includes("pending.attempts = 0") ? [webhookRow({ attempts: 1 })] : []));
    await processSquareWebhooks(db, workerDependencies);

    const [arrivals, general] = claims(executed);
    // The arrivals lane is defined by "nothing has looked at this yet". That is what makes its
    // guarantee independent of the backlog: no retried row is eligible to compete for it.
    expect(arrivals!.text).toContain("pending.attempts = 0");
    expect(arrivals!.values).toContain(webhookArrivalReserve);
    expect(general!.text).not.toContain("pending.attempts = 0");
    // And the general lane only ever gets what the reserve did not use.
    expect(general!.values).toContain(webhookClaimBatch - 1);
  });

  it("gives the whole budget to the general lane when nothing new has arrived", async () => {
    const { db, executed } = recordingDatabase(() => []);
    expect(await processSquareWebhooks(db, workerDependencies)).toBe(0);
    const [arrivals, general] = claims(executed);
    expect(arrivals!.values).toContain(webhookArrivalReserve);
    expect(general!.values).toContain(webhookClaimBatch);
  });

  it("never lets the reserve be spent on retries, however large the backlog", async () => {
    // Ten first attempts and an unbounded retry backlog: the reserve is filled by arrivals and
    // the general lane is capped at what is left, so a current event is claimed on this tick
    // rather than waiting for the backlog to drain.
    const arrivalRows = Array.from({ length: webhookArrivalReserve }, (_, index) =>
      webhookRow({ id: `arrival-${index}`, attempts: 0 }));
    const { db, executed } = recordingDatabase((statement) => {
      if (!statement.text.includes("for update skip locked")) return [];
      return statement.text.includes("pending.attempts = 0")
        ? arrivalRows
        : Array.from({ length: webhookClaimBatch - webhookArrivalReserve }, (_, index) =>
            webhookRow({ id: `backlog-${index}`, attempts: 6 }));
    });
    expect(await processSquareWebhooks(db, workerDependencies)).toBe(webhookClaimBatch);
    const [, general] = claims(executed);
    expect(general!.values).toContain(webhookClaimBatch - webhookArrivalReserve);
  });

  it("orders the general lane by schedule rather than by arrival", async () => {
    const { db, executed } = recordingDatabase(() => []);
    await processSquareWebhooks(db, workerDependencies);
    const [arrivals, general] = claims(executed);
    // THE REGRESSION GUARD. `order by pending.received_at` as the leading key over the whole
    // eligible set is the defect: a claim does not change `received_at`, so a row that has been
    // attempted eleven times still outranks an event that arrived a second ago, forever. Every
    // claim DOES move `next_attempt_at` into the future, which is what bounds the wait.
    expect(general!.text).toContain("order by pending.next_attempt_at, pending.received_at, pending.id");
    // Within the reserve, arrival order is correct and safe: every row in it has been attempted
    // zero times, so no row can be re-selected ahead of another.
    expect(arrivals!.text).toContain("order by pending.received_at, pending.id");
    for (const claim of [arrivals!, general!]) {
      // Terminal rows carry `processed_at`, so neither lane can see a processed, parked or
      // dead-lettered event at all - they cannot starve anything because they are not eligible.
      expect(claim.text).toContain("pending.processed_at is null");
      expect(claim.text).toContain("pending.next_attempt_at <= now()");
      // Concurrency is unchanged: two instances on one tick take disjoint rows.
      expect(claim.text).toContain("for update skip locked");
      // The claim increments attempts and fences the row before any handler runs, so a crash
      // costs one backoff rather than a hot loop against Square.
      expect(claim.text).toContain("attempts=event.attempts+1");
      expect(claim.text).toContain("next_attempt_at=now() + interval '10 minutes'");
    }
  });

  it("still retries a failure and still dead-letters one that has run out of attempts", async () => {
    // An unparseable payload throws inside the handler, which is the drain's generic failure
    // path. The two outcomes below are the retry and dead-letter semantics the split claim must
    // not have disturbed.
    for (const [attempts, expected] of [[1, "status='failed'"], [maxWebhookAttempts, "status='dead_letter'"]] as const) {
      const { db, executed } = recordingDatabase((statement) =>
        (statement.text.includes("pending.attempts = 0")
          ? [webhookRow({ attempts, payloadText: "{ not json" })]
          : []));
      await processSquareWebhooks(db, workerDependencies);
      const writes = executed.filter((statement) => statement.text.includes("update square_webhook_events set")
        && !statement.text.includes("for update skip locked"));
      expect(writes.map((statement) => statement.text.replace(/\s+/g, " ")).join(" "))
        .toContain(expected.replace(/\s+/g, " "));
    }
  });

  it("marks a row it acted on as processed exactly once", async () => {
    const { db, executed } = recordingDatabase((statement) =>
      (statement.text.includes("pending.attempts = 0") ? [webhookRow()] : []));
    await processSquareWebhooks(db, workerDependencies);
    const settle = executed.filter((statement) => statement.text.includes("processed_at=now()"));
    expect(settle).toHaveLength(1);
    expect(settle[0]!.text).toContain("business_id=coalesce(business_id,");
  });
});

describe("the Square connection refresh's claim policy", () => {
  it("reserves part of the budget for connections that are not already failing", async () => {
    const { db, executed } = recordingDatabase(() => []);
    await refreshDueConnections(db, workerDependencies);
    const [healthy, general] = claims(executed);
    // `refresh_attempts = 0` is exactly "not in a failure cycle": a success resets it, a failure
    // leaves it above zero. This table has NO resting state - nothing dead-letters a connection -
    // so without a reserve an unbounded set of permanently broken rows occupies the whole tick
    // and a healthy connection's access token expires while it waits.
    expect(healthy!.text).toContain("due.refresh_attempts = 0");
    expect(healthy!.values).toContain(connectionRefreshHealthyReserve);
    expect(general!.text).not.toContain("due.refresh_attempts = 0");
    expect(general!.values).toContain(connectionRefreshBatch);
    for (const claim of [healthy!, general!]) {
      expect(claim.text).toContain("order by due.next_refresh_at, due.id");
      expect(claim.text).toContain("due.status='connected'");
      expect(claim.text).toContain("due.next_refresh_at <= now()");
      expect(claim.text).toContain("for update skip locked");
      expect(claim.text).toContain("refresh_attempts=connection.refresh_attempts+1");
      expect(claim.text).toContain("next_refresh_at=now() + interval '15 minutes'");
    }
  });

  it("leaves the general lane only what the reserve did not use", async () => {
    const { db, executed } = recordingDatabase((statement) => (statement.text.includes("due.refresh_attempts = 0")
      ? [{ id: "a", businessId: "b", refreshToken: "sealed", squareMerchantId: "M", refreshAttempts: 1 }]
      : []));
    await refreshDueConnections(db, workerDependencies);
    const [, general] = claims(executed);
    expect(general!.values).toContain(connectionRefreshBatch - 1);
  });

  it("clamps the failure backoff exponent without changing the schedule it produces", async () => {
    const { db, executed } = recordingDatabase((statement) => (statement.text.includes("due.refresh_attempts = 0")
      ? [{ id: "a", businessId: "b", refreshToken: "sealed", squareMerchantId: "M", refreshAttempts: 400 }]
      : []));
    await refreshDueConnections(db, workerDependencies);
    const backoff = executed.find((statement) => statement.text.includes("last_refresh_error="));
    // `least(interval '6 hours', ...)` already wins from the eighth attempt, so clamping the
    // exponent changes no schedule this backoff has ever produced. It is there because
    // `refresh_attempts` on this table has no ceiling, and around three hundred attempts
    // `power(2, n)` overflows what an interval can hold - PostgreSQL raises rather than
    // multiplying, aborting the worker tick from inside its own error handler.
    expect(backoff!.text).toContain("least(interval '6 hours',");
    expect(backoff!.text).toContain("interval '5 minutes' * power(2, least(");
    expect(backoff!.values).toContain(400);
  });
});
