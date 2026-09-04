import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../src/db/client.js";
import {
  connectionRefreshBatch, connectionRefreshHealthyReserve, refreshDueConnections
} from "../../src/integrations/square/oauth.js";
import {
  processSquareWebhooks, webhookArrivalReserve, webhookClaimBatch
} from "../../src/integrations/square/webhooks.js";

/**
 * A worker tick must reach work that arrived recently, whatever has piled up in front of it.
 *
 * THE DEFECT. The webhook drain claimed globally, oldest-first, `limit 25`. `received_at` never
 * moves, so a row that has been attempted eleven times sorted ahead of an event that arrived a
 * second ago forever: past twenty-five accumulated retryable rows the current event was simply
 * not in the batch. The connection refresh had the same budget problem on the one Square table
 * with NO resting state - nothing dead-letters a connection - so the set of rows competing for
 * its ten-row budget can only grow.
 *
 * WHAT THE FIX IS. Each tick claims in two passes. A reserved lane takes only rows nothing has
 * looked at yet, so its guarantee does not depend on the size of the backlog; the general lane
 * takes the rest in SCHEDULE order, which every claim moves forward, so the backlog itself drains
 * with a bounded wait rather than one subset of it monopolising the lane.
 *
 * These tests are the ones that need a real PostgreSQL: `for update skip locked` actually
 * excluding a concurrently claimed row, and the ten-minute fence actually removing a row from the
 * next statement's view, are properties of the server. The claim POLICY - which rows each lane
 * may see and how the budget is split - is pinned without a server in
 * `tests/integrations/square-worker-claim.test.ts`.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const workerDependencies = {
  environment: "sandbox",
  keyring: {
    open: () => "plain-refresh-token",
    seal: () => ({ value: "sealed", keyVersion: 1 })
  },
  client: {
    refreshAccessToken: () => { throw new Error("Square is unreachable in this suite"); }
  }
} as never;

describeDatabase("Square worker fairness", () => {
  let db: Database;
  const merchant = `MFAIR${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const businesses: string[] = [];

  beforeAll(async () => {
    db = createDatabase({ DATABASE_URL: databaseUrl! });
  });

  afterAll(async () => {
    // This suite deliberately creates rows in bulk, which no other suite does. Removing its own
    // fixtures keeps that from becoming a fact other suites in the same run have to survive.
    await db`delete from square_webhook_events where merchant_id=${merchant}`;
    if (businesses.length) {
      await db`delete from square_connections where business_id = any(${businesses})`;
      await db`delete from businesses where id = any(${businesses})`;
    }
    await db.end();
  });

  async function insertWebhookEvent(input: {
    eventId: string;
    receivedAgo: string;
    dueAgo?: string;
    attempts?: number;
    status?: string;
    terminal?: boolean;
  }): Promise<void> {
    await db`
      insert into square_webhook_events
        (event_id, merchant_id, event_type, payload, received_at, next_attempt_at, attempts,
         status, processed_at)
      values (${input.eventId}, ${merchant}, 'inventory.count.updated', ${db.json({}) as never},
        now() - ${input.receivedAgo}::interval,
        now() - ${input.dueAgo ?? "1 minute"}::interval,
        ${input.attempts ?? 0}, ${input.status ?? "pending"},
        ${input.terminal ? db`now()` : null})
    `;
  }

  it("processes a current event on the first tick behind a backlog it cannot drain", async () => {
    // Comfortably more than the whole budget, all older and all due: under the previous claim
    // this is the state in which the new event below is never in the batch.
    const backlog = webhookClaimBatch * 5;
    for (let index = 0; index < backlog; index += 1) {
      await insertWebhookEvent({
        eventId: `${merchant}-old-${index}`,
        receivedAgo: `${10 - index / backlog} days`,
        attempts: 3,
        status: "failed"
      });
    }
    await insertWebhookEvent({ eventId: `${merchant}-current`, receivedAgo: "1 second" });

    const claimed = await processSquareWebhooks(db, workerDependencies);
    expect(claimed).toBe(webhookClaimBatch);
    const [current] = await db<{ status: string; attempts: number }[]>`
      select status, attempts from square_webhook_events where event_id=${`${merchant}-current`}
    `;
    expect(current!.attempts).toBe(1);
    expect(current!.status).toBe("processed");
  });

  it("never claims an event that has come to rest, so terminal rows cannot starve active ones", async () => {
    const resting = ["processed", "parked", "dead_letter"];
    for (const status of resting) {
      for (let index = 0; index < webhookClaimBatch; index += 1) {
        await insertWebhookEvent({
          eventId: `${merchant}-rest-${status}-${index}`,
          receivedAgo: "30 days",
          dueAgo: "20 days",
          attempts: 4,
          status,
          terminal: true
        });
      }
    }
    await insertWebhookEvent({ eventId: `${merchant}-active`, receivedAgo: "1 second" });

    await processSquareWebhooks(db, workerDependencies);
    // Scoped to the rows this test created: every one of them is older and more overdue than
    // anything else in the table, so if a resting row were claimable at all it would be claimed
    // ahead of `-active`.
    const [untouched] = await db<{ count: number }[]>`
      select count(*)::int as count from square_webhook_events
      where event_id like ${`${merchant}-rest-%`}
        and (attempts <> 4 or processed_at is null or status not in ('processed','parked','dead_letter'))
    `;
    expect(untouched!.count).toBe(0);
    const [active] = await db<{ attempts: number }[]>`
      select attempts from square_webhook_events where event_id=${`${merchant}-active`}
    `;
    expect(active!.attempts).toBe(1);
  });

  it("does not let two workers on one tick claim the same row twice", async () => {
    await db`
      update square_webhook_events
      set status='failed', processed_at=null, attempts=3, next_attempt_at=now()-interval '1 minute'
      where merchant_id=${merchant} and event_id like ${`${merchant}-old-%`}
    `;
    const [before] = await db<{ total: number }[]>`
      select coalesce(sum(attempts),0)::int as total from square_webhook_events
      where merchant_id=${merchant}
    `;
    const [first, second] = await Promise.all([
      processSquareWebhooks(db, workerDependencies),
      processSquareWebhooks(db, workerDependencies)
    ]);
    const [after] = await db<{ total: number }[]>`
      select coalesce(sum(attempts),0)::int as total from square_webhook_events
      where merchant_id=${merchant}
    `;
    // Every claimed row is incremented exactly once. Had the two ticks overlapped, the total
    // would move by less than the rows they between them reported claiming.
    expect(after!.total - before!.total).toBe(first + second);
    expect(first + second).toBeLessThanOrEqual(webhookClaimBatch * 2);
  });

  it("claims the same amount from the same state however many times it is repeated", async () => {
    // Determinism is a property of the harness as much as of the worker: this only holds if the
    // run began from a database nothing earlier left rows in.
    const counts: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db`
        update square_webhook_events
        set status='failed', processed_at=null, attempts=2, next_attempt_at=now()-interval '1 minute'
        where merchant_id=${merchant} and event_id like ${`${merchant}-old-%`}
      `;
      counts.push(await processSquareWebhooks(db, workerDependencies));
    }
    expect(counts).toEqual([webhookClaimBatch, webhookClaimBatch, webhookClaimBatch]);
    // And the reserve is never spent on the backlog: every row above has been attempted, so the
    // arrivals lane finds nothing and the general lane takes the whole budget.
    expect(webhookArrivalReserve).toBeLessThan(webhookClaimBatch);
  });

  it("refreshes a healthy connection that is due behind a wall of broken ones", async () => {
    async function business(name: string): Promise<string> {
      const [row] = await db<{ id: string }[]>`
        insert into businesses (name) values (${name}) returning id
      `;
      businesses.push(row!.id);
      return row!.id;
    }
    // Four times the budget, every one of them failing, every one of them due before the healthy
    // connection. Nothing dead-letters these: this is the state that grows without bound.
    for (let index = 0; index < connectionRefreshBatch * 4; index += 1) {
      await db`
        insert into square_connections
          (business_id, environment, square_merchant_id, status, scopes, key_version,
           access_token, refresh_token, next_refresh_at, refresh_attempts, last_refresh_error)
        values (${await business(`Broken ${index}`)}, 'sandbox', ${`${merchant}B${index}`},
          'connected', array['PAYMENTS_READ'], 1, 'sealed-access', 'sealed-refresh',
          now() - interval '2 hours', ${7 + index}, 'Square said no')
      `;
    }
    const healthy = await business("Healthy");
    await db`
      insert into square_connections
        (business_id, environment, square_merchant_id, status, scopes, key_version,
         access_token, refresh_token, next_refresh_at, refresh_attempts)
      values (${healthy}, 'sandbox', ${`${merchant}HEALTHY`}, 'connected',
        array['PAYMENTS_READ'], 1, 'sealed-access', 'sealed-refresh',
        now() - interval '1 minute', 0)
    `;

    await refreshDueConnections(db, workerDependencies);
    const [claimed] = await db<{ refreshAttempts: number }[]>`
      select refresh_attempts from square_connections where business_id=${healthy}
    `;
    // The claim increments before the network call, so a claimed connection has moved off zero.
    expect(claimed!.refreshAttempts).toBe(1);
    expect(connectionRefreshHealthyReserve).toBeGreaterThan(0);
    expect(connectionRefreshHealthyReserve).toBeLessThan(connectionRefreshBatch);
  });

  it("still writes a backoff for a connection that has failed more times than an interval can hold", async () => {
    const [row] = await db<{ businessId: string }[]>`
      select business_id from square_connections
      where square_merchant_id=${`${merchant}HEALTHY`}
    `;
    // `power(2, 400)` overflows what an interval can hold; unclamped, PostgreSQL raises inside
    // the worker's own error handler and takes the rest of the tick with it.
    await db`
      update square_connections
      set refresh_attempts=400, next_refresh_at=now()-interval '1 minute'
      where business_id=${row!.businessId}
    `;
    await db`
      update square_connections set next_refresh_at=now()+interval '7 days'
      where square_merchant_id like ${`${merchant}B%`}
    `;
    await expect(refreshDueConnections(db, workerDependencies)).resolves.toBe(0);
    const [scheduled] = await db<{ hours: number }[]>`
      select (extract(epoch from (next_refresh_at - now()))/3600)::float8 as hours
      from square_connections where business_id=${row!.businessId}
    `;
    // The cap the backoff has always produced from the eighth attempt onward.
    expect(scheduled!.hours).toBeGreaterThan(5.9);
    expect(scheduled!.hours).toBeLessThanOrEqual(6);
  });
});
