import { describe, expect, it } from "vitest";
import { claimStatements, recordingDatabase } from "../support/recording-database.js";
import {
  deliverNotifications, notificationDeliveryBatch, notificationFirstAttemptReserve
} from "../../src/engagement/worker.js";

/**
 * The claim policy of the notification drain, pinned without a server.
 *
 * THE DEFECT THIS EXISTS TO STOP COMING BACK. `order by scheduled_occurrence` is not a total
 * order over this table. Almost every intent is written with `scheduled_occurrence` of `now()`,
 * and rows written in one transaction share one timestamp exactly, so once more than
 * `notificationDeliveryBatch` are eligible the membership of the batch was decided by whatever
 * order the executor returned equal keys in - stable between two runs of the same query only by
 * luck. A given intent had no progress guarantee inside a burst at all.
 *
 * The same three properties as the Square drains: the order is total, its middle key is the one
 * the claim actually moves, and part of the budget is reserved for rows nothing has tried yet.
 */

function intentRow(overrides: Partial<{ id: string; attempts: number; destination: string | null }> = {}) {
  return {
    id: overrides.id ?? "22222222-2222-2222-2222-222222222222",
    businessId: "33333333-3333-3333-3333-333333333333",
    destination: overrides.destination === undefined ? "person@example.test" : overrides.destination,
    notificationType: "appointment_reminder",
    attempts: overrides.attempts ?? 1,
    encryptedBody: null,
    startAt: null,
    timezone: null,
    businessName: "Pawsh Salon",
    petName: "Maple",
    customerName: "Taylor Guardian",
    expirationDate: null,
    businessPhone: null,
    businessEmail: null,
    dateFormat: null,
    hourFormat: null,
    customerNotificationStatus: null
  };
}

const sendingProvider = () => {
  const sent: string[] = [];
  return {
    sent,
    provider: {
      async send(message: { idempotencyKey: string }) {
        sent.push(message.idempotencyKey);
        return { providerReference: `test:${message.idempotencyKey}` };
      }
    }
  };
};

describe("the notification drain's claim policy", () => {
  it("orders totally, and by the key the claim moves", async () => {
    const { db, executed } = recordingDatabase(() => []);
    await deliverNotifications(db, sendingProvider().provider);
    for (const claim of claimStatements(executed)) {
      // `scheduled_occurrence` leads because it is a product fact - when the notification is due
      // - and is part of `unique_appointment_notification`, so it is not a retry schedule and
      // must never be rewritten as one. `updated_at` is what the claim advances, so it demotes a
      // row that has just been attempted below its tied peers. `id` makes the order total, which
      // is what removes the arbitrariness rather than merely narrowing it.
      expect(claim.text).toContain("order by due.scheduled_occurrence, due.updated_at, due.id");
      // The eligibility predicate is untouched: `sent`, `cancelled` and `suppressed` are as
      // invisible as they have always been, and `attempts<5` still retires an intent for good.
      expect(claim.text).toContain("due.status in ('pending','failed')");
      expect(claim.text).toContain("due.status='sending' and due.updated_at<now()-interval '10 minutes'");
      expect(claim.text).toContain("due.scheduled_occurrence<=now() and due.attempts<5");
      expect(claim.text).toContain("for update skip locked");
      // The claim moves the row out of the eligible set before any send is attempted, which is
      // what stops a crash between claiming and sending becoming a hot loop at the provider.
      expect(claim.text).toContain("status='sending',attempts=intent.attempts+1,updated_at=now()");
    }
  });

  it("reserves part of the budget for intents nothing has tried to send yet", async () => {
    const { db, executed } = recordingDatabase(() => []);
    await deliverNotifications(db, sendingProvider().provider);
    const [reserve, general] = claimStatements(executed);
    expect(reserve!.text).toContain("due.attempts=0");
    expect(reserve!.values).toContain(notificationFirstAttemptReserve);
    expect(general!.text).not.toContain("due.attempts=0");
    // Nothing new was found, so the general lane gets the whole budget.
    expect(general!.values).toContain(notificationDeliveryBatch);
  });

  it("leaves the general lane only what the reserve did not use", async () => {
    const { db, executed } = recordingDatabase((statement) =>
      (statement.text.includes("due.attempts=0") ? [intentRow({ attempts: 1 })] : []));
    expect(await deliverNotifications(db, sendingProvider().provider)).toBe(1);
    const [, general] = claimStatements(executed);
    expect(general!.values).toContain(notificationDeliveryBatch - 1);
  });

  it("never spends the reserve on a retrying backlog, however large", async () => {
    const fresh = Array.from({ length: notificationFirstAttemptReserve }, (_, index) =>
      intentRow({ id: `fresh-${index}`, attempts: 0 }));
    const { db, executed } = recordingDatabase((statement) => {
      if (!statement.text.includes("for update skip locked")) return [];
      return statement.text.includes("due.attempts=0")
        ? fresh
        : Array.from({ length: notificationDeliveryBatch - notificationFirstAttemptReserve },
          (_, index) => intentRow({ id: `backlog-${index}`, attempts: 4 }));
    });
    expect(await deliverNotifications(db, sendingProvider().provider)).toBe(notificationDeliveryBatch);
    const [, general] = claimStatements(executed);
    expect(general!.values).toContain(notificationDeliveryBatch - notificationFirstAttemptReserve);
  });

  it("sends each claimed intent exactly once and records one attempt for it", async () => {
    const { sent, provider } = sendingProvider();
    const { db, executed } = recordingDatabase((statement) =>
      (statement.text.includes("due.attempts=0") ? [intentRow({ id: "only", attempts: 1 })] : []));
    await deliverNotifications(db, provider);
    // Split claiming must not become split sending: one row claimed is one message, whichever
    // lane it came from.
    expect(sent).toEqual(["only"]);
    const attempts = executed.filter((statement) =>
      statement.text.includes("insert into notification_delivery_attempts"));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.text).toContain("'sent'");
    expect(attempts[0]!.text).toContain("on conflict do nothing");
    const settle = executed.filter((statement) => statement.text.includes("set status='sent'"));
    expect(settle).toHaveLength(1);
  });

  it("still records a failure as a failure rather than losing the intent", async () => {
    const { db, executed } = recordingDatabase((statement) =>
      // No destination: the drain's own generic failure path, unchanged by the split claim.
      (statement.text.includes("due.attempts=0")
        ? [intentRow({ id: "undeliverable", attempts: 3, destination: null })]
        : []));
    await deliverNotifications(db, sendingProvider().provider);
    const failed = executed.filter((statement) => statement.text.includes("outcome, error"));
    expect(failed).toHaveLength(1);
    const marked = executed.filter((statement) => statement.text.includes("set status='failed'"));
    expect(marked).toHaveLength(1);
    // Nothing deletes an intent, and nothing marks it sent.
    expect(executed.some((statement) => statement.text.includes("delete from notification_intents")))
      .toBe(false);
    expect(executed.some((statement) => statement.text.includes("set status='sent'"))).toBe(false);
  });
});
