import { describe, expect, it } from "vitest";
import { canTransition, overlaps } from "../../src/domain/appointments.js";

describe("appointment invariants", () => {
  it("allows only defined state transitions", () => {
    expect(canTransition("scheduled", "checked_in")).toBe(true);
    expect(canTransition("completed", "checked_in")).toBe(false);
    expect(canTransition("cancelled", "in_service")).toBe(false);
  });

  it("uses half-open time intervals", () => {
    const first = { startAt: new Date("2026-01-01T09:00:00Z"), endAt: new Date("2026-01-01T10:00:00Z") };
    const adjacent = { startAt: new Date("2026-01-01T10:00:00Z"), endAt: new Date("2026-01-01T11:00:00Z") };
    const overlap = { startAt: new Date("2026-01-01T09:30:00Z"), endAt: new Date("2026-01-01T10:30:00Z") };
    expect(overlaps(first, adjacent)).toBe(false);
    expect(overlaps(first, overlap)).toBe(true);
  });
});
