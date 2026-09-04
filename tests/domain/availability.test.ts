import { describe, expect, it } from "vitest";
import {
  MINUTES_PER_DAY,
  availabilityOverrideMayBypass,
  availabilityRefusalCodes,
  clockMinutes,
  coversWindow,
  dayPeriodForInstants,
  refuseWindow,
  resolveEffectiveAvailability,
  type AvailabilityInputs,
  type AvailabilityReason,
  type DateOverride,
  type WeekdayPeriod
} from "../../src/domain/availability.js";
import { localDateBounds, localDateForInstant, resolveWallTime, WallTimeError } from "../../src/domain/time.js";

const zone = "America/Los_Angeles";

/** Tuesday 2026-03-10, an ordinary date with no daylight-saving transition on it. */
const TUESDAY = 2;

const staffTuesday: WeekdayPeriod = { weekday: TUESDAY, startTime: "09:00", endTime: "17:00", appointmentLimit: 1 };
const salonTuesday: WeekdayPeriod = { weekday: TUESDAY, startTime: "08:00", endTime: "18:00" };

function inputs(overrides: Partial<AvailabilityInputs> = {}): AvailabilityInputs {
  return {
    weekday: TUESDAY,
    locationClosed: false,
    dateOverride: null,
    staffWeekdayHours: [staffTuesday],
    locationBusinessHours: [salonTuesday],
    blocked: [],
    ...overrides
  };
}

const workingOverride: DateOverride = {
  working: true, startTime: "12:00", endTime: "20:00", appointmentLimit: 1
};

describe("effective availability precedence", () => {
  it("resolves an ordinary day to the staff hours bounded by the salon hours", () => {
    const result = resolveEffectiveAvailability(inputs());
    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.periods).toEqual([{ startMinute: 9 * 60, endMinute: 17 * 60 }]);
    expect(result.appointmentLimit).toBe(1);
  });

  describe("1. a location closure is terminal", () => {
    it("closes the day even when the groomer's weekday hours are open", () => {
      const result = resolveEffectiveAvailability(inputs({ locationClosed: true }));
      expect(result).toMatchObject({ available: false, reason: "location_closed", periods: [] });
    });

    // The trap the module exists to prevent: a per-date override saying "yes, working" reads like
    // it should reopen the shop. It must not. The shop being shut is a fact about the premises.
    it("beats a per-date override that says the groomer IS working", () => {
      const result = resolveEffectiveAvailability(inputs({
        locationClosed: true,
        dateOverride: workingOverride
      }));
      expect(result.available).toBe(false);
      expect(result.reason).toBe("location_closed");
    });

    it("beats an unrestricted groomer and an unbounded location together", () => {
      const result = resolveEffectiveAvailability(inputs({
        locationClosed: true,
        staffWeekdayHours: [],
        locationBusinessHours: []
      }));
      expect(result.reason).toBe("location_closed");
      // The fail-open flags are still reported; they simply do not change a closed verdict.
      expect(result.staffUnrestricted).toBe(true);
      expect(result.locationUnbounded).toBe(true);
    });
  });

  describe("2. a per-date override replaces the weekday default", () => {
    it("uses the override window and never merges it with the weekday row", () => {
      const result = resolveEffectiveAvailability(inputs({
        dateOverride: workingOverride,
        locationBusinessHours: []
      }));
      // 12:00-20:00, NOT 09:00-20:00 (a union) and NOT 12:00-17:00 (an intersection).
      expect(result.periods).toEqual([{ startMinute: 12 * 60, endMinute: 20 * 60 }]);
    });

    it("turns the day off when the override says not working, whatever the weekday row says", () => {
      const result = resolveEffectiveAvailability(inputs({
        dateOverride: { working: false, startTime: null, endTime: null, appointmentLimit: 1 }
      }));
      expect(result).toMatchObject({ available: false, reason: "date_override_off", periods: [] });
    });

    it("opens a weekday the groomer does not normally work", () => {
      const result = resolveEffectiveAvailability(inputs({
        weekday: 0,
        staffWeekdayHours: [staffTuesday],
        locationBusinessHours: [],
        dateOverride: workingOverride
      }));
      expect(result.available).toBe(true);
      expect(result.periods).toEqual([{ startMinute: 12 * 60, endMinute: 20 * 60 }]);
    });

    it("is still bounded by the salon hours", () => {
      const result = resolveEffectiveAvailability(inputs({ dateOverride: workingOverride }));
      // Salon closes at 18:00, so the override's 20:00 is cut back rather than honoured.
      expect(result.periods).toEqual([{ startMinute: 12 * 60, endMinute: 18 * 60 }]);
    });

    // The second trap: an override describes the groomer's hours. It says nothing about time
    // already spoken for, so a block still applies on an overridden date.
    it("does NOT clear a blocked time", () => {
      const result = resolveEffectiveAvailability(inputs({
        dateOverride: workingOverride,
        locationBusinessHours: [],
        blocked: [{ startMinute: 13 * 60, endMinute: 14 * 60 }]
      }));
      expect(result.periods).toEqual([
        { startMinute: 12 * 60, endMinute: 13 * 60 },
        { startMinute: 14 * 60, endMinute: 20 * 60 }
      ]);
    });
  });

  describe("3. the weekday default, and the employee fail-open branch", () => {
    it("closes a weekday the groomer has no row for", () => {
      const result = resolveEffectiveAvailability(inputs({ weekday: 0 }));
      expect(result).toMatchObject({ available: false, reason: "outside_staff_hours" });
      expect(result.staffUnrestricted).toBe(false);
    });

    // Load-bearing. `groomersAvailable` treats a groomer with no configured hours as bookable at
    // any time, and closing this branch would stop every unconfigured groomer taking bookings.
    it("leaves an employee with NO rows at all unrestricted, not closed", () => {
      const result = resolveEffectiveAvailability(inputs({
        staffWeekdayHours: [],
        locationBusinessHours: []
      }));
      expect(result.available).toBe(true);
      expect(result.staffUnrestricted).toBe(true);
      expect(result.periods).toEqual([{ startMinute: 0, endMinute: MINUTES_PER_DAY }]);
    });

    it("keeps an unrestricted employee unrestricted on every weekday", () => {
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const result = resolveEffectiveAvailability(inputs({
          weekday, staffWeekdayHours: [], locationBusinessHours: []
        }));
        expect(result.available, `weekday ${weekday}`).toBe(true);
      }
    });

    it("still bounds an unrestricted employee by the salon hours", () => {
      const result = resolveEffectiveAvailability(inputs({ staffWeekdayHours: [] }));
      expect(result.periods).toEqual([{ startMinute: 8 * 60, endMinute: 18 * 60 }]);
    });
  });

  describe("4. the salon hours intersect, and the location fail-open branch", () => {
    it("narrows the groomer's hours to the salon's", () => {
      const result = resolveEffectiveAvailability(inputs({
        staffWeekdayHours: [{ weekday: TUESDAY, startTime: "06:00", endTime: "22:00" }],
        locationBusinessHours: [salonTuesday]
      }));
      expect(result.periods).toEqual([{ startMinute: 8 * 60, endMinute: 18 * 60 }]);
    });

    it("closes a weekday the salon has no row for, even when the groomer works it", () => {
      const result = resolveEffectiveAvailability(inputs({
        weekday: 0,
        staffWeekdayHours: [{ weekday: 0, startTime: "09:00", endTime: "17:00" }],
        locationBusinessHours: [salonTuesday]
      }));
      expect(result).toMatchObject({ available: false, reason: "outside_business_hours" });
    });

    it("reports outside_business_hours when the two do not overlap at all", () => {
      const result = resolveEffectiveAvailability(inputs({
        staffWeekdayHours: [{ weekday: TUESDAY, startTime: "19:00", endTime: "22:00" }]
      }));
      expect(result).toMatchObject({ available: false, reason: "outside_business_hours" });
    });

    // The other load-bearing branch. A live location today has zero `business_hours` rows;
    // treating that as "closed" would stop it taking bookings the moment this shipped.
    it("leaves a location with NO rows at all unbounded, not closed", () => {
      const result = resolveEffectiveAvailability(inputs({ locationBusinessHours: [] }));
      expect(result.available).toBe(true);
      expect(result.locationUnbounded).toBe(true);
      expect(result.periods).toEqual([{ startMinute: 9 * 60, endMinute: 17 * 60 }]);
    });

    it("leaves an unconfigured groomer at an unconfigured location open all day", () => {
      const result = resolveEffectiveAvailability(inputs({
        staffWeekdayHours: [], locationBusinessHours: []
      }));
      expect(result.periods).toEqual([{ startMinute: 0, endMinute: MINUTES_PER_DAY }]);
    });
  });

  describe("5. blocked times subtract and never widen", () => {
    it("splits a period around a block in the middle of it", () => {
      const result = resolveEffectiveAvailability(inputs({
        blocked: [{ startMinute: 12 * 60, endMinute: 13 * 60 }]
      }));
      expect(result.periods).toEqual([
        { startMinute: 9 * 60, endMinute: 12 * 60 },
        { startMinute: 13 * 60, endMinute: 17 * 60 }
      ]);
    });

    it("cannot widen a day: a block outside the hours changes nothing", () => {
      const bounded = resolveEffectiveAvailability(inputs());
      const withOutsideBlock = resolveEffectiveAvailability(inputs({
        blocked: [{ startMinute: 3 * 60, endMinute: 4 * 60 }, { startMinute: 20 * 60, endMinute: 22 * 60 }]
      }));
      expect(withOutsideBlock.periods).toEqual(bounded.periods);
    });

    it("reports fully_blocked when a block covers the whole day", () => {
      const result = resolveEffectiveAvailability(inputs({
        blocked: [{ startMinute: 0, endMinute: MINUTES_PER_DAY }]
      }));
      expect(result).toMatchObject({ available: false, reason: "fully_blocked", periods: [] });
    });

    it("merges overlapping blocks rather than double-subtracting them", () => {
      const result = resolveEffectiveAvailability(inputs({
        blocked: [
          { startMinute: 10 * 60, endMinute: 12 * 60 },
          { startMinute: 11 * 60, endMinute: 13 * 60 }
        ]
      }));
      expect(result.periods).toEqual([
        { startMinute: 9 * 60, endMinute: 10 * 60 },
        { startMinute: 13 * 60, endMinute: 17 * 60 }
      ]);
    });

    it("blocks an otherwise unrestricted groomer for exactly the blocked window", () => {
      const result = resolveEffectiveAvailability(inputs({
        staffWeekdayHours: [], locationBusinessHours: [],
        blocked: [{ startMinute: 9 * 60, endMinute: 10 * 60 }]
      }));
      expect(result.periods).toEqual([
        { startMinute: 0, endMinute: 9 * 60 },
        { startMinute: 10 * 60, endMinute: MINUTES_PER_DAY }
      ]);
    });
  });

  describe("6. the limit follows whichever row supplied the hours", () => {
    it("takes the weekday row's limit when there is no override", () => {
      const result = resolveEffectiveAvailability(inputs({
        staffWeekdayHours: [{ ...staffTuesday, appointmentLimit: 3 }]
      }));
      expect(result.appointmentLimit).toBe(3);
    });

    it("takes the override's limit when there is one, not the weekday row's", () => {
      const result = resolveEffectiveAvailability(inputs({
        staffWeekdayHours: [{ ...staffTuesday, appointmentLimit: 3 }],
        dateOverride: { ...workingOverride, appointmentLimit: 2 }
      }));
      expect(result.appointmentLimit).toBe(2);
    });

    it("defaults an unconfigured groomer to one", () => {
      expect(resolveEffectiveAvailability(inputs({
        staffWeekdayHours: [], locationBusinessHours: []
      })).appointmentLimit).toBe(1);
    });
  });

  describe("full precedence ordering", () => {
    // Every adjacent pair in the chain, asserted as a chain: each restriction in turn takes over
    // from the one below it.
    it("prefers closure over override over weekday over salon over block, in that order", () => {
      const base = inputs({
        dateOverride: workingOverride,
        blocked: [{ startMinute: 13 * 60, endMinute: 14 * 60 }]
      });
      expect(resolveEffectiveAvailability({ ...base, locationClosed: true }).reason).toBe("location_closed");
      expect(resolveEffectiveAvailability({
        ...base, dateOverride: { working: false, startTime: null, endTime: null, appointmentLimit: 1 }
      }).reason).toBe("date_override_off");
      expect(resolveEffectiveAvailability({ ...base, dateOverride: null, weekday: 0 }).reason).toBe("outside_staff_hours");
      expect(resolveEffectiveAvailability({
        ...base, dateOverride: null, locationBusinessHours: [{ weekday: TUESDAY, startTime: "19:00", endTime: "20:00" }]
      }).reason).toBe("outside_business_hours");
      expect(resolveEffectiveAvailability({
        ...base, blocked: [{ startMinute: 0, endMinute: MINUTES_PER_DAY }]
      }).reason).toBe("fully_blocked");
      expect(resolveEffectiveAvailability(base).available).toBe(true);
    });
  });

  describe("coversWindow", () => {
    it("accepts a booking inside a period and rejects one that straddles a block", () => {
      const result = resolveEffectiveAvailability(inputs({
        blocked: [{ startMinute: 12 * 60, endMinute: 13 * 60 }]
      }));
      expect(coversWindow(result, { startMinute: 10 * 60, endMinute: 11 * 60 })).toBe(true);
      expect(coversWindow(result, { startMinute: 11 * 60 + 30, endMinute: 13 * 60 + 30 })).toBe(false);
      expect(coversWindow(result, { startMinute: 16 * 60, endMinute: 18 * 60 })).toBe(false);
    });

    it("never covers anything on a closed day", () => {
      const closed = resolveEffectiveAvailability(inputs({ locationClosed: true }));
      expect(coversWindow(closed, { startMinute: 10 * 60, endMinute: 11 * 60 })).toBe(false);
    });
  });

  describe("clock parsing", () => {
    it("accepts both the API's HH:MM and PostgreSQL's HH:MM:SS", () => {
      expect(clockMinutes("09:30")).toBe(570);
      expect(clockMinutes("09:30:00")).toBe(570);
      expect(clockMinutes("24:00")).toBe(MINUTES_PER_DAY);
    });

    it("refuses a value it cannot place on a clock", () => {
      expect(() => clockMinutes("9pm")).toThrow(/Invalid clock time/);
      expect(() => clockMinutes("25:00")).toThrow(/Invalid clock time/);
      expect(() => clockMinutes("09:99")).toThrow(/Invalid clock time/);
    });
  });
});

/**
 * Availability is wall-clock at the LOCATION, so the two dates a year where wall clock and
 * elapsed time disagree are where a naive implementation breaks. Spring forward in
 * America/Los_Angeles is 2026-03-08 (02:00 -> 03:00, a 23-hour day) and fall back is 2026-11-01
 * (02:00 -> 01:00, a 25-hour day).
 */
describe("daylight-saving boundaries", () => {
  const springForward = "2026-03-08";
  const fallBack = "2026-11-01";

  it("resolves the closure day's own bounds to 23 and 25 hours", () => {
    const spring = localDateBounds(springForward, zone);
    expect(spring.from.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(spring.to.toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect((spring.to.getTime() - spring.from.getTime()) / 3_600_000).toBe(23);

    const fall = localDateBounds(fallBack, zone);
    expect(fall.from.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(fall.to.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect((fall.to.getTime() - fall.from.getTime()) / 3_600_000).toBe(25);
  });

  it("puts an instant either side of the transition on the right local closure date", () => {
    // 01:30 PST and 03:30 PDT: both are 2026-03-08 locally despite the hour that never happened.
    expect(localDateForInstant(new Date("2026-03-08T09:30:00.000Z"), zone)).toBe(springForward);
    expect(localDateForInstant(new Date("2026-03-08T10:30:00.000Z"), zone)).toBe(springForward);
    // One minute earlier is still the previous day, so a closure on the 8th must not catch it.
    expect(localDateForInstant(new Date("2026-03-08T07:59:00.000Z"), zone)).toBe("2026-03-07");
    // Both occurrences of 01:30 on the fall-back date belong to that date.
    expect(localDateForInstant(new Date("2026-11-01T08:30:00.000Z"), zone)).toBe(fallBack);
    expect(localDateForInstant(new Date("2026-11-01T09:30:00.000Z"), zone)).toBe(fallBack);
  });

  it("keeps per-date override boundaries on the wall clock across both transitions", () => {
    const override: DateOverride = { working: true, startTime: "09:00", endTime: "17:00", appointmentLimit: 1 };
    for (const localDate of [springForward, fallBack]) {
      const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay();
      const result = resolveEffectiveAvailability(inputs({
        weekday, dateOverride: override, staffWeekdayHours: [], locationBusinessHours: []
      }));
      // 09:00-17:00 means 09:00-17:00 on a 23-hour day and on a 25-hour day alike.
      expect(result.periods, localDate).toEqual([{ startMinute: 9 * 60, endMinute: 17 * 60 }]);
      // And the wall time still resolves to a real instant on both dates.
      expect(resolveWallTime(`${localDate}T09:00`, zone).instant.toISOString()).toBeTruthy();
    }
  });

  it("refuses the hour that does not exist and the hour that happens twice", () => {
    expect(() => resolveWallTime(`${springForward}T02:30`, zone)).toThrow(WallTimeError);
    expect(() => resolveWallTime(`${fallBack}T01:30`, zone)).toThrow(WallTimeError);
    expect(resolveWallTime(`${fallBack}T01:30`, zone, "earlier").instant.toISOString())
      .toBe("2026-11-01T08:30:00.000Z");
    expect(resolveWallTime(`${fallBack}T01:30`, zone, "later").instant.toISOString())
      .toBe("2026-11-01T09:30:00.000Z");
  });

  it("projects a blocked instant range onto the local day, clamped at both ends", () => {
    // 10:00-11:00 PDT on the spring-forward date, entirely inside the day.
    expect(dayPeriodForInstants(
      { startAt: new Date("2026-03-08T17:00:00.000Z"), endAt: new Date("2026-03-08T18:00:00.000Z") },
      springForward, zone
    )).toEqual({ startMinute: 10 * 60, endMinute: 11 * 60 });

    // A block starting the previous evening clamps to local midnight rather than going negative.
    expect(dayPeriodForInstants(
      { startAt: new Date("2026-03-08T04:00:00.000Z"), endAt: new Date("2026-03-08T17:00:00.000Z") },
      springForward, zone
    )).toEqual({ startMinute: 0, endMinute: 10 * 60 });

    // A block running into the next day clamps to the end of this one.
    expect(dayPeriodForInstants(
      { startAt: new Date("2026-11-01T22:00:00.000Z"), endAt: new Date("2026-11-03T00:00:00.000Z") },
      fallBack, zone
    )).toEqual({ startMinute: 14 * 60, endMinute: MINUTES_PER_DAY });

    // A block on another day does not touch this one at all.
    expect(dayPeriodForInstants(
      { startAt: new Date("2026-03-10T17:00:00.000Z"), endAt: new Date("2026-03-10T18:00:00.000Z") },
      springForward, zone
    )).toBeNull();
  });

  it("subtracts a repeated fall-back hour conservatively rather than widening the day", () => {
    // 01:00-02:00 PDT is the FIRST occurrence of that hour; its wall-clock projection covers the
    // repeated hour, so both occurrences come out of the day. Subtractive, never additive.
    const blocked = dayPeriodForInstants(
      { startAt: new Date("2026-11-01T08:00:00.000Z"), endAt: new Date("2026-11-01T09:00:00.000Z") },
      fallBack, zone
    );
    expect(blocked).toEqual({ startMinute: 60, endMinute: 120 });
    const result = resolveEffectiveAvailability(inputs({
      weekday: new Date(`${fallBack}T00:00:00Z`).getUTCDay(),
      staffWeekdayHours: [], locationBusinessHours: [], blocked: [blocked!]
    }));
    expect(result.periods).toEqual([
      { startMinute: 0, endMinute: 60 },
      { startMinute: 120, endMinute: MINUTES_PER_DAY }
    ]);
  });
});

/**
 * Which of the five refusals a SPECIFIC window walks into, and which of them "book them anyway"
 * may bypass.
 *
 * `coversWindow` answers yes or no. The booking routes have to answer a fifth question on top of
 * the four the resolver already answers - WHICH restriction refused this - because the four codes
 * go to four different screens, and because one of them outranks the override while three do not.
 */
describe("refuseWindow attributes a refusal to the restriction that caused it", () => {
  const morning = { startMinute: 10 * 60, endMinute: 11 * 60 };

  const reasonFor = (overrides: Partial<AvailabilityInputs>, window = morning) =>
    refuseWindow(resolveEffectiveAvailability(inputs(overrides)), window);

  it("reports nothing for a window that fits", () => {
    expect(reasonFor({})).toBeNull();
  });

  it("passes a whole-day verdict straight through rather than re-deriving it", () => {
    // A closed salon and a day off are facts about the DAY. The window is irrelevant to both, so
    // the same answer comes back for a window that would otherwise have fitted perfectly.
    expect(reasonFor({ locationClosed: true })).toBe("location_closed");
    expect(reasonFor({
      dateOverride: { working: false, startTime: null, endTime: null, appointmentLimit: 1 }
    })).toBe("date_override_off");
  });

  it("names the groomer's hours before the salon's when both would refuse", () => {
    // 20:00 is past a 17:00 groomer AND past an 18:00 salon. Answering "the salon is closed then"
    // would send an operator to edit the wrong grid, so precedence order decides.
    const reason = reasonFor({}, { startMinute: 20 * 60, endMinute: 21 * 60 });
    expect(reason).toBe("outside_staff_hours");
  });

  it("names the salon's hours when only the salon refuses", () => {
    // The groomer works 09:00-17:00; the salon opens at 11:00. A 10:00 booking is inside the
    // groomer's day and outside the shop's.
    expect(reasonFor({
      locationBusinessHours: [{ weekday: TUESDAY, startTime: "11:00", endTime: "18:00" }]
    })).toBe("outside_business_hours");
  });

  it("names the block when the window survived both grids", () => {
    // Whole-window, and one-minute-clipped, both refuse: a block that removes any part of the
    // window removes the window.
    expect(reasonFor({ blocked: [{ startMinute: 10 * 60, endMinute: 11 * 60 }] })).toBe("fully_blocked");
    expect(reasonFor({ blocked: [{ startMinute: 10 * 60 + 59, endMinute: 11 * 60 }] })).toBe("fully_blocked");
    // A block that merely abuts the window does not touch it - the intervals are half-open.
    expect(reasonFor({ blocked: [{ startMinute: 11 * 60, endMinute: 12 * 60 }] })).toBeNull();
  });

  it("still reports the block when a per-date override supplied the hours", () => {
    // The documented trap, asserted through the refusal rather than only through the periods: an
    // override describes the groomer's hours and says nothing about time already spoken for.
    expect(reasonFor({
      dateOverride: workingOverride,
      blocked: [{ startMinute: 13 * 60, endMinute: 14 * 60 }]
    }, { startMinute: 13 * 60, endMinute: 14 * 60 })).toBe("fully_blocked");
  });

  it("gives every reason a wire code, and every code a distinct one", () => {
    const codes = Object.values(availabilityRefusalCodes);
    expect(new Set(codes).size).toBe(codes.length);
    expect(availabilityRefusalCodes).toEqual({
      location_closed: "LOCATION_CLOSED",
      date_override_off: "STAFF_DATE_UNAVAILABLE",
      outside_staff_hours: "OUTSIDE_STAFF_HOURS",
      outside_business_hours: "OUTSIDE_BUSINESS_HOURS",
      fully_blocked: "TIME_BLOCKED"
    });
  });
});

describe("what an availability override may and may not bypass", () => {
  it("bypasses the three ordinary scheduling-hour restrictions", () => {
    // Exactly the set the single boolean predicate this replaced allowed it to bypass, so a
    // workspace with no per-date rows behaves as it did before the domain authority was wired in.
    for (const reason of ["outside_staff_hours", "outside_business_hours", "fully_blocked"] as const) {
      expect(availabilityOverrideMayBypass(reason), reason).toBe(true);
    }
  });

  it("never bypasses a closed salon or an explicit date-level unavailability", () => {
    // Two different kinds of no. The first is about the premises; the second is somebody having
    // stated, for this employee and this date, that they are not there. Neither is an
    // ordinary-hours judgement, which is all the override is.
    expect(availabilityOverrideMayBypass("location_closed")).toBe(false);
    expect(availabilityOverrideMayBypass("date_override_off")).toBe(false);
  });

  it("classifies every reason the resolver can emit, with no default branch to hide a new one", () => {
    const reasons = Object.keys(availabilityRefusalCodes) as AvailabilityReason[];
    expect(reasons.filter(availabilityOverrideMayBypass)).toEqual([
      "outside_staff_hours", "outside_business_hours", "fully_blocked"
    ]);
  });
});
