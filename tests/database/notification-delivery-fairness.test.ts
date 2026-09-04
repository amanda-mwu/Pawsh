import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../src/db/client.js";
import {
  deliverNotifications, notificationDeliveryBatch, notificationFirstAttemptReserve,
  type EmailMessage, type EmailProvider
} from "../../src/engagement/worker.js";

/**
 * Every intent that is due gets sent, and none of them gets sent twice.
 *
 * THE DEFECT. The drain claimed `order by scheduled_occurrence ... limit 25`, and that is not a
 * total order over this table: almost every intent is written with `scheduled_occurrence` of
 * `now()`, and rows written in one transaction share one transaction timestamp exactly. Once
 * more than a batch of them were eligible, which twenty-five the tick took was decided by
 * whatever order the executor returned equal keys in - so a particular intent had no progress
 * guarantee inside a burst, and the same query could answer differently twice in a row. That is
 * a production fairness defect and it was also an intermittent test failure: two rabies intents
 * that mattered, thirty-four tied peers, and a coin toss.
 *
 * These are the tests that need a real PostgreSQL, because ties, `skip locked` and the status
 * fence are all properties of the server. The claim POLICY - the ordering keys, the eligibility
 * predicate and the reserved lane - is pinned without one in
 * `tests/domain/notification-delivery-claim.test.ts`.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

function recordingProvider(): { sent: string[]; provider: EmailProvider } {
  const sent: string[] = [];
  return {
    sent,
    provider: {
      async send(message: EmailMessage) {
        sent.push(message.idempotencyKey);
        return { providerReference: `test:${message.idempotencyKey}` };
      }
    }
  };
}

const refusingProvider: EmailProvider = {
  async send() { throw new Error("The provider refused this message"); }
};

describeDatabase("notification delivery fairness", () => {
  let db: Database;
  let businessId: string;
  const marker = `fairness-${crypto.randomUUID()}`;

  beforeAll(async () => {
    db = createDatabase({ DATABASE_URL: databaseUrl! });
    const [business] = await db<{ id: string }[]>`
      insert into businesses (name) values (${`Fairness ${marker}`}) returning id
    `;
    businessId = business!.id;
  });

  afterAll(async () => {
    // This suite creates intents in bulk, which no other suite does, and the drain is global. Its
    // own rows must not become something the rest of the run has to survive.
    await db`
      delete from notification_delivery_attempts where business_id=${businessId}
    `;
    await db`delete from notification_intents where business_id=${businessId}`;
    await db`delete from businesses where id=${businessId}`;
    await db.end();
  });

  /**
   * Inserts `count` intents in ONE statement, so every row genuinely shares one
   * `scheduled_occurrence` - which is what makes them tie, and is exactly how a real burst
   * arrives.
   */
  async function insertTiedBurst(input: {
    label: string; count: number; dueAgo: string; attempts?: number; status?: string;
  }): Promise<void> {
    await db`
      insert into notification_intents
        (business_id, notification_type, scheduled_occurrence, channel, destination, status,
         attempts)
      select ${businessId}::uuid, ${`test_${input.label}`}::text,
        now() - ${input.dueAgo}::interval, 'email',
        concat(${`${input.label}-`}::text, index, '@example.test'),
        ${input.status ?? "pending"}::text, ${input.attempts ?? 0}::int
      from generate_series(1, ${input.count}::int) as index
    `;
  }

  const ofType = (label: string) => db<{
    id: string; destination: string; status: string; attempts: number;
  }[]>`
    select id, destination, status, attempts from notification_intents
    where business_id=${businessId} and notification_type=${`test_${label}`}
    order by destination
  `;

  /**
   * The drain is GLOBAL and cross-tenant, and it sends the oldest-due notification first - which
   * is correct product behaviour and is what these tests are here to protect. It also means a
   * test that wants to know where its own rows sit in the queue has to say so: every other suite
   * in the run that leaves an undelivered intent behind is another row ahead of them.
   *
   * So the fixtures below are dated far enough back to be at the head of the queue, and this
   * asserts that premise rather than assuming it. If some future suite ever queues something
   * older, this fails with a sentence instead of a mystifying off-by-a-few count.
   */
  async function expectNothingOlderThan(age: string): Promise<void> {
    const [foreign] = await db<{ count: number }[]>`
      select count(*)::int as count from notification_intents
      where business_id<>${businessId}
        and (
          status in ('pending','failed')
          or (status='sending' and updated_at<now()-interval '10 minutes')
        )
        and scheduled_occurrence<=now()-${age}::interval and attempts<5
    `;
    expect(foreign!.count, `another suite has queued an intent older than ${age}`).toBe(0);
  }

  it("drains a tied burst completely, sending every intent exactly once", async () => {
    const count = notificationDeliveryBatch * 2 + 7;
    await insertTiedBurst({ label: "burst", count, dueAgo: "365 days" });
    await expectNothingOlderThan("365 days");
    const [tied] = await db<{ distinct: number }[]>`
      select count(distinct scheduled_occurrence)::int as distinct from notification_intents
      where business_id=${businessId} and notification_type='test_burst'
    `;
    // The premise: these really are indistinguishable on the old ordering key.
    expect(tied!.distinct).toBe(1);

    const { sent, provider } = recordingProvider();
    const mine = new Set((await ofType("burst")).map((row) => row.id));
    let ticks = 0;
    for (;;) {
      const outstanding = (await ofType("burst")).filter((row) => row.status !== "sent");
      if (!outstanding.length) break;
      ticks += 1;
      expect(ticks, "the burst did not drain").toBeLessThanOrEqual(10);
      expect(await deliverNotifications(db, provider)).toBeGreaterThan(0);
    }
    const rows = await ofType("burst");
    expect(rows).toHaveLength(count);
    expect(rows.every((row) => row.status === "sent")).toBe(true);
    // Exactly once each: the claim is the only gate, and a row leaves the eligible set the moment
    // it is claimed. Checked over everything this drain sent, not only over these rows, because a
    // double send of somebody else's intent would be the same defect.
    expect(new Set(sent).size).toBe(sent.length);
    expect(sent.filter((id) => mine.has(id))).toHaveLength(count);
    const [attempts] = await db<{ maximum: number }[]>`
      select coalesce(max(attempt_count),0)::int as maximum from (
        select count(*)::int as attempt_count from notification_delivery_attempts
        where business_id=${businessId} group by notification_intent_id
      ) per_intent
    `;
    expect(attempts!.maximum).toBe(1);
    // Bounded, not merely eventual. These rows are at the head of the queue - the premise
    // asserted above - so each tick spends the whole budget on them.
    expect(ticks).toBe(Math.ceil(count / notificationDeliveryBatch));
  });

  it("moves on to intents it has not tried, rather than re-trying the ones that just failed", async () => {
    // THE SHARPEST STATEMENT OF WHAT THE `updated_at` KEY BUYS, and the exact shape that made the
    // rabies suite intermittent. A tied burst is claimed, every send fails, and each failure puts
    // its row straight back into the eligible set carrying its ORIGINAL `scheduled_occurrence`.
    // On the leading key alone those rows are indistinguishable from the peers that have never
    // been tried, so the next tick was free to take the same ones again and leave the untried
    // ones sitting there. The claim advances `updated_at`, so a row it has just handled now sorts
    // behind its tied peers and the next tick reaches them instead.
    const count = notificationDeliveryBatch * 2;
    await insertTiedBurst({ label: "rotation", count, dueAgo: "300 days" });
    await expectNothingOlderThan("300 days");
    expect(await deliverNotifications(db, refusingProvider)).toBe(notificationDeliveryBatch);
    expect(await deliverNotifications(db, refusingProvider)).toBe(notificationDeliveryBatch);
    const rows = await ofType("rotation");
    expect(rows).toHaveLength(count);
    // Every intent tried once, none tried twice, after exactly two ticks.
    expect(rows.filter((row) => row.attempts === 1)).toHaveLength(count);
    expect(rows.filter((row) => row.attempts > 1)).toHaveLength(0);
  });

  it("claims a newly due intent on the first tick behind a retrying backlog", async () => {
    // Older, more overdue, and still retryable: under the previous claim this is the wall a new
    // intent waited behind for as many ticks as the backlog had attempts left.
    await insertTiedBurst({
      label: "backlog", count: notificationDeliveryBatch * 3, dueAgo: "280 days",
      attempts: 3, status: "failed"
    });
    // Younger than the backlog, so ONLY the reserve can reach it: the general lane serves the
    // seventy-five older rows first and never gets past them in one tick. Older than anything
    // any other suite has queued, so the reserve is not spent on somebody else's first attempts.
    await insertTiedBurst({ label: "current", count: 1, dueAgo: "270 days" });
    await expectNothingOlderThan("270 days");

    const { provider } = recordingProvider();
    const claimed = await deliverNotifications(db, provider);
    expect(claimed).toBe(notificationDeliveryBatch);
    const [current] = await ofType("current");
    expect(current!.attempts).toBe(1);
    expect(current!.status).toBe("sent");
    expect(notificationFirstAttemptReserve).toBeGreaterThan(0);
    expect(notificationFirstAttemptReserve).toBeLessThan(notificationDeliveryBatch);
  });

  it("never claims an intent that has come to rest, or one that has run out of attempts", async () => {
    for (const status of ["sent", "cancelled", "suppressed"]) {
      await insertTiedBurst({ label: `rest_${status}`, count: 5, dueAgo: "20 days", status,
        // `notification_destination_consistency` allows a null destination only for the two
        // resting states that never send; these carry one either way.
        attempts: 1 });
    }
    await insertTiedBurst({ label: "exhausted", count: 5, dueAgo: "20 days", attempts: 5,
      status: "failed" });

    const { provider } = recordingProvider();
    await deliverNotifications(db, provider);
    for (const label of ["rest_sent", "rest_cancelled", "rest_suppressed"]) {
      const rows = await ofType(label);
      expect(rows.every((row) => row.attempts === 1), label).toBe(true);
    }
    const exhausted = await ofType("exhausted");
    // `attempts<5` is this table's give-up, and it still is.
    expect(exhausted.every((row) => row.attempts === 5 && row.status === "failed")).toBe(true);
  });

  it("does not let two ticks running at once claim the same intent", async () => {
    await insertTiedBurst({ label: "concurrent", count: notificationDeliveryBatch * 2,
      dueAgo: "1 minute" });
    const first = recordingProvider();
    const second = recordingProvider();
    const [a, b] = await Promise.all([
      deliverNotifications(db, first.provider),
      deliverNotifications(db, second.provider)
    ]);
    const overlap = first.sent.filter((id) => second.sent.includes(id));
    expect(overlap).toEqual([]);
    expect(first.sent.length + second.sent.length).toBe(a + b);
    const [duplicated] = await db<{ count: number }[]>`
      select count(*)::int as count from (
        select notification_intent_id from notification_delivery_attempts
        where business_id=${businessId} group by notification_intent_id, attempt_number
        having count(*) > 1
      ) offenders
    `;
    expect(duplicated!.count).toBe(0);
  });

  it("retries a refused send and records each attempt, without ever losing the intent", async () => {
    // Deliberately the oldest thing due anywhere, so the general lane reaches it on every tick
    // rather than serving the fixtures the earlier tests left behind. Retry behaviour is what is
    // under test here, not who goes first.
    await insertTiedBurst({ label: "refused", count: 1, dueAgo: "400 days" });
    await expectNothingOlderThan("400 days");
    const [before] = await ofType("refused");
    for (let tick = 0; tick < 6; tick += 1) await deliverNotifications(db, refusingProvider);
    const [after] = await ofType("refused");
    // Five attempts and then it stops being claimed - unchanged from before the split claim.
    expect(after!.attempts).toBe(5);
    expect(after!.status).toBe("failed");
    expect(after!.id).toBe(before!.id);
    const [recorded] = await db<{ count: number }[]>`
      select count(*)::int as count from notification_delivery_attempts
      where notification_intent_id=${after!.id} and outcome='failed'
    `;
    expect(recorded!.count).toBe(5);
  });
});
