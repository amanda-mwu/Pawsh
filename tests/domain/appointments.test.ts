import { describe, expect, it } from "vitest";
import { appointmentStatuses, canTransition, overlaps } from "../../src/domain/appointments.js";

describe("appointment invariants", () => {
  it("allows the complete lifecycle contract and rejects every other edge", () => {
    const allowed = new Set([
      "scheduled:checked_in",
      "scheduled:cancelled",
      "scheduled:no_show",
      "checked_in:in_service",
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
