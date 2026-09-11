import { describe, expect, it } from "vitest";
import { appointmentStatuses, canEnterCheckout, canTransition, checkoutEligibleStatuses, overlaps } from "@pawsh/domain";

const transitionsFrom = (from: string): string[] =>
  appointmentStatuses.filter((target) => canTransition(from as never, target));

describe("appointment invariants", () => {
  it("allows the complete lifecycle contract and rejects every other edge", () => {
    const allowed = new Set([
      "scheduled:checked_in",
      "scheduled:cancelled",
      "scheduled:no_show",
      "checked_in:in_service",
      // "Ready for Pickup" on a checked-in visit. See the table's own note for why this is an
      // edge rather than a shortcut: plenty of work is never marked started.
      "checked_in:completed",
      "in_service:completed"
    ]);
    for (const source of appointmentStatuses) {
      for (const target of appointmentStatuses) {
        expect(canTransition(source, target), `${source} -> ${target}`).toBe(
          allowed.has(`${source}:${target}`)
        );
      }
    }
  });

  it("bills a visit that is here or finished, and refuses the four that are neither", () => {
    // Written out rather than derived from `checkoutEligibleStatuses`, so that widening the set
    // by one more status has to be a deliberate edit in two places instead of a test that agrees
    // with whatever the constant happens to say.
    const billable = new Set(["checked_in", "completed"]);
    for (const status of appointmentStatuses) {
      expect(canEnterCheckout(status), status).toBe(billable.has(status));
    }
  });

  it("names only real statuses as billable", () => {
    for (const status of checkoutEligibleStatuses) {
      expect(appointmentStatuses).toContain(status);
    }
  });

  it("keeps billing and the lifecycle as two separate questions", () => {
    // Every status that may be billed and every status that may be reached are decided by
    // different tables, and neither consults the other. `checked_in` is billable AND may move on
    // to `completed`; `in_service` may move on and may NOT be billed; `completed` is billable and
    // moves nowhere at all. That the three disagree is the point - a visit's money and a visit's
    // progress are not the same fact, and the route that takes payment writes no status.
    expect([canEnterCheckout("checked_in"), canTransition("checked_in", "completed")]).toEqual([true, true]);
    expect([canEnterCheckout("in_service"), canTransition("in_service", "completed")]).toEqual([false, true]);
    expect([canEnterCheckout("completed"), transitionsFrom("completed")]).toEqual([true, []]);
  });

  it("uses half-open time intervals", () => {
    const first = { startAt: new Date("2026-01-01T09:00:00Z"), endAt: new Date("2026-01-01T10:00:00Z") };
    const adjacent = { startAt: new Date("2026-01-01T10:00:00Z"), endAt: new Date("2026-01-01T11:00:00Z") };
    const overlapStart = { startAt: new Date("2026-01-01T08:30:00Z"), endAt: new Date("2026-01-01T09:30:00Z") };
    const overlapEnd = { startAt: new Date("2026-01-01T09:30:00Z"), endAt: new Date("2026-01-01T10:30:00Z") };
    const contains = { startAt: new Date("2026-01-01T08:30:00Z"), endAt: new Date("2026-01-01T10:30:00Z") };
    const contained = { startAt: new Date("2026-01-01T09:15:00Z"), endAt: new Date("2026-01-01T09:45:00Z") };
    const identical = { ...first };
    expect(overlaps(first, adjacent)).toBe(false);
    expect(overlaps(first, overlapStart)).toBe(true);
    expect(overlaps(first, overlapEnd)).toBe(true);
    expect(overlaps(first, contains)).toBe(true);
    expect(overlaps(first, contained)).toBe(true);
    expect(overlaps(first, identical)).toBe(true);
  });
});
