/**
 * Effective staff availability for one groomer, on one calendar date, at one location.
 *
 * This is the single place the precedence between the five things that can restrict a day is
 * written down. Nothing here touches the database or the clock: callers load the rows and hand
 * them over, which is what makes every ordering pair below testable without a booking.
 *
 * The order is:
 *
 *   1. A location closure day closes the date. Terminal - staff availability is never consulted,
 *      and no override reopens it.
 *   2. A per-date staff override REPLACES the weekday default. It is never merged with it and
 *      never intersected with it: `working = false` is a day off, and `working = true` is that
 *      day's hours in full.
 *   3. Otherwise the weekday default from `employee_working_hours`. No row for that weekday means
 *      the groomer does not work that weekday. The exception is an employee with no rows at all,
 *      who is unrestricted - see the fail-open note below.
 *   4. Intersect with the location's `business_hours` for that weekday. A location with no rows at
 *      all imposes no bound - the second fail-open branch.
 *   5. Subtract `blocked_times`. Subtractive only: a blocked interval can never widen a day.
 *   6. The limit comes from step 2 when a per-date row exists, otherwise from step 3.
 *
 * Two traps worth stating outright, because both look like they should work the other way:
 *
 *   * A per-date override with `working = true` does NOT reopen a closed salon day. Step 1 has
 *     already returned by the time step 2 is reached.
 *   * A per-date override does NOT clear `blocked_times`. Step 5 subtracts from whatever step 2
 *     produced, exactly as it subtracts from a weekday default.
 *
 * FAIL-OPEN, DELIBERATELY. An employee with zero working-hours rows is unrestricted, and a
 * location with zero business-hours rows is unbounded. Both branches are load-bearing in the
 * booking path this now backs: a live location today has no `business_hours` rows at all, and
 * closing either branch would silently stop it taking bookings. "No hours configured" means
 * "not configured", not "closed".
 *
 * WHO CALLS THIS. `refuseStaffAvailability` in `src/http/routes.ts`, which is the only staff
 * availability verdict `POST /api/appointments` and `PATCH /api/appointments/:id/schedule` take.
 * The SQL predicate that used to answer that question separately is gone; there is one set of
 * rules and it is written here.
 *
 * Times are wall-clock minutes from local midnight in the LOCATION's timezone. They are never
 * instants: 09:00 is 09:00 on both sides of a daylight-saving transition, and converting a weekly
 * schedule to UTC would move it twice a year. Callers convert instants (blocked times) into this
 * frame with `src/domain/time.ts` before calling in.
 */

import { formatWallTime } from "./time.js";

/** A half-open wall-clock interval within one local day, in minutes from local midnight. */
export interface DayPeriod {
  startMinute: number;
  endMinute: number;
}

export const MINUTES_PER_DAY = 24 * 60;

/** One stored weekday row, from `employee_working_hours` or `business_hours`. */
export interface WeekdayPeriod {
  weekday: number;
  startTime: string;
  endTime: string;
  appointmentLimit?: number;
}

/** One stored `employee_date_availability` row. */
export interface DateOverride {
  working: boolean;
  startTime: string | null;
  endTime: string | null;
  appointmentLimit: number;
}

export interface AvailabilityInputs {
  /** Local weekday of the date being resolved, 0 (Sunday) to 6, in the location's timezone. */
  weekday: number;
  /** Whether `location_closure_days` holds this date for this location. */
  locationClosed: boolean;
  /** The `employee_date_availability` row for this date, or null when there is none. */
  dateOverride: DateOverride | null;
  /**
   * EVERY `employee_working_hours` row this employee has, across all weekdays - not just the
   * matching one. The empty case is what distinguishes "does not work Tuesdays" from "has no
   * schedule configured", and only the full set can tell them apart.
   */
  staffWeekdayHours: readonly WeekdayPeriod[];
  /** EVERY `business_hours` row this location has, for the same reason. */
  locationBusinessHours: readonly WeekdayPeriod[];
  /** Blocked intervals clamped to this local day. Order and overlap do not matter. */
  blocked: readonly DayPeriod[];
}

export type AvailabilityReason =
  | "location_closed"
  | "date_override_off"
  | "outside_staff_hours"
  | "outside_business_hours"
  | "fully_blocked";

export interface EffectiveAvailability {
  available: boolean;
  reason: AvailabilityReason | null;
  /** Sorted, disjoint, and non-empty exactly when `available`. */
  periods: readonly DayPeriod[];
  /**
   * What steps 2 and 3 produced, BEFORE the location bound and before the blocks. Reported so a
   * caller asking "why does this particular booking not fit" can be answered without the caller
   * re-deriving any of the six steps: see `refuseWindow`. Empty whenever `available` is false,
   * because an unavailable day already carries its own reason.
   */
  staffPeriods: readonly DayPeriod[];
  /** The same, after step 4's intersection and before step 5's subtraction. */
  boundedPeriods: readonly DayPeriod[];
  appointmentLimit: number;
  /** True when the employee has no working-hours rows at all, and so is unrestricted. */
  staffUnrestricted: boolean;
  /** True when the location has no business-hours rows at all, and so imposes no bound. */
  locationUnbounded: boolean;
}

const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Minutes from local midnight for a stored `time` value. PostgreSQL renders `time` as `HH:MM:SS`
 * while the API speaks `HH:MM`, so both are accepted; seconds are truncated because no
 * availability boundary in Pawsh is finer than a minute.
 */
export function clockMinutes(value: string): number {
  const match = CLOCK.exec(value.trim());
  if (!match) throw new Error(`Invalid clock time: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) throw new Error(`Invalid clock time: ${value}`);
  return hours * 60 + minutes;
}

/**
 * A stored instant range - a blocked time - projected onto one local day as wall-clock minutes,
 * clamped at both ends. Returns null when the range does not touch the day at all.
 *
 * This is the one conversion in the availability path, and it goes in this direction on purpose:
 * blocked times are genuinely instants (a groomer is away from 14:00 to 15:00 on one specific
 * afternoon), while working hours are genuinely wall-clock (09:00 every Tuesday, on both sides of
 * a daylight-saving change). Projecting the instant onto the wall clock keeps the schedule fixed
 * where it belongs.
 *
 * On a day with a daylight-saving transition, wall-clock minutes are not elapsed minutes: the day
 * is 23 or 25 hours long. Fall back is the dangerous direction. An hour blocked from 01:00 PDT to
 * 01:00 PST is a real, hour-long absence whose two endpoints read as the SAME wall time, so a
 * naive projection collapses it to nothing and silently drops the block. Where the wall clock
 * loses time this falls back to the elapsed duration, which subtracts both occurrences of the
 * repeated hour. Over-subtracting is the safe direction: step 5 is subtractive-only, and a block
 * that quietly disappeared would hand out time a groomer is not there for.
 */
export function dayPeriodForInstants(
  range: { startAt: Date; endAt: Date },
  localDate: string,
  timeZone: string
): DayPeriod | null {
  const edge = (instant: Date): number => {
    const wall = formatWallTime(instant, timeZone);
    const date = wall.slice(0, 10);
    if (date < localDate) return 0;
    if (date > localDate) return MINUTES_PER_DAY;
    return clockMinutes(wall.slice(11));
  };
  const startMinute = edge(range.startAt);
  const endMinute = edge(range.endAt);
  if (endMinute > startMinute) return { startMinute, endMinute };
  // Both ends clamped to the same edge of the day: the range does not touch this day at all.
  if (startMinute === 0 || startMinute === MINUTES_PER_DAY) return null;
  const elapsedMinutes = Math.round((range.endAt.getTime() - range.startAt.getTime()) / 60_000);
  if (elapsedMinutes <= 0) return null;
  const conservativeEnd = Math.min(MINUTES_PER_DAY, startMinute + elapsedMinutes);
  return conservativeEnd > startMinute ? { startMinute, endMinute: conservativeEnd } : null;
}

function normalize(periods: readonly DayPeriod[]): DayPeriod[] {
  const ordered = periods
    .filter((period) => period.endMinute > period.startMinute)
    .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
  const merged: DayPeriod[] = [];
  for (const period of ordered) {
    const last = merged.at(-1);
    if (last && period.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, period.endMinute);
      continue;
    }
    merged.push({ ...period });
  }
  return merged;
}

function intersect(left: readonly DayPeriod[], right: readonly DayPeriod[]): DayPeriod[] {
  const result: DayPeriod[] = [];
  for (const a of left) {
    for (const b of right) {
      const startMinute = Math.max(a.startMinute, b.startMinute);
      const endMinute = Math.min(a.endMinute, b.endMinute);
      if (endMinute > startMinute) result.push({ startMinute, endMinute });
    }
  }
  return normalize(result);
}

function subtract(from: readonly DayPeriod[], cuts: readonly DayPeriod[]): DayPeriod[] {
  let remaining = normalize(from);
  for (const cut of normalize(cuts)) {
    const next: DayPeriod[] = [];
    for (const period of remaining) {
      if (cut.endMinute <= period.startMinute || cut.startMinute >= period.endMinute) {
        next.push(period);
        continue;
      }
      if (cut.startMinute > period.startMinute) {
        next.push({ startMinute: period.startMinute, endMinute: cut.startMinute });
      }
      if (cut.endMinute < period.endMinute) {
        next.push({ startMinute: cut.endMinute, endMinute: period.endMinute });
      }
    }
    remaining = next;
  }
  return normalize(remaining);
}

function unavailable(
  reason: AvailabilityReason,
  appointmentLimit: number,
  flags: { staffUnrestricted: boolean; locationUnbounded: boolean }
): EffectiveAvailability {
  return {
    available: false, reason, periods: [], staffPeriods: [], boundedPeriods: [],
    appointmentLimit, ...flags
  };
}

export function resolveEffectiveAvailability(inputs: AvailabilityInputs): EffectiveAvailability {
  const staffUnrestricted = inputs.staffWeekdayHours.length === 0;
  const locationUnbounded = inputs.locationBusinessHours.length === 0;
  const flags = { staffUnrestricted, locationUnbounded };

  // Step 1. Terminal. Nothing below this line can reopen the shop, including a per-date override
  // that says the groomer is working.
  if (inputs.locationClosed) return unavailable("location_closed", 1, flags);

  // Steps 2 and 3, and step 6's limit, resolved together: whichever source supplies the day's
  // hours also supplies its limit, and the two must never come from different rows.
  let staffPeriods: DayPeriod[];
  let appointmentLimit: number;
  if (inputs.dateOverride) {
    if (!inputs.dateOverride.working) {
      return unavailable("date_override_off", inputs.dateOverride.appointmentLimit, flags);
    }
    // Replacement, not a merge: the weekday row is not read at all on an overridden date.
    staffPeriods = [{
      startMinute: clockMinutes(inputs.dateOverride.startTime!),
      endMinute: clockMinutes(inputs.dateOverride.endTime!)
    }];
    appointmentLimit = inputs.dateOverride.appointmentLimit;
  } else if (staffUnrestricted) {
    // Fail-open: no schedule configured is not a closed schedule.
    staffPeriods = [{ startMinute: 0, endMinute: MINUTES_PER_DAY }];
    appointmentLimit = 1;
  } else {
    const today = inputs.staffWeekdayHours.filter((period) => period.weekday === inputs.weekday);
    if (!today.length) return unavailable("outside_staff_hours", 1, flags);
    staffPeriods = today.map((period) => ({
      startMinute: clockMinutes(period.startTime),
      endMinute: clockMinutes(period.endTime)
    }));
    appointmentLimit = Math.max(1, ...today.map((period) => period.appointmentLimit ?? 1));
  }
  staffPeriods = normalize(staffPeriods);
  if (!staffPeriods.length) return unavailable("outside_staff_hours", appointmentLimit, flags);

  // Step 4. A location with no rows at all bounds nothing; one with rows but none for this
  // weekday is shut that weekday, and the intersection is correctly empty.
  let boundedPeriods = staffPeriods;
  if (!locationUnbounded) {
    const salonToday = inputs.locationBusinessHours.filter((period) => period.weekday === inputs.weekday);
    if (!salonToday.length) return unavailable("outside_business_hours", appointmentLimit, flags);
    boundedPeriods = intersect(boundedPeriods, salonToday.map((period) => ({
      startMinute: clockMinutes(period.startTime),
      endMinute: clockMinutes(period.endTime)
    })));
    if (!boundedPeriods.length) return unavailable("outside_business_hours", appointmentLimit, flags);
  }

  // Step 5. Subtractive only. A blocked interval survives a per-date override, because the
  // override describes the groomer's hours while the block describes time already spoken for.
  const periods = subtract(boundedPeriods, inputs.blocked);
  if (!periods.length) return unavailable("fully_blocked", appointmentLimit, flags);

  return {
    available: true, reason: null, periods, staffPeriods, boundedPeriods, appointmentLimit, ...flags
  };
}

/**
 * The wire code each refusal reports.
 *
 * These are separated from the messages so the interface can say something specific - "the salon
 * is closed that day" reads very differently from "that is outside the groomer's hours", and a
 * single generic availability refusal made the two indistinguishable.
 */
export const availabilityRefusalCodes: Record<AvailabilityReason, string> = {
  location_closed: "LOCATION_CLOSED",
  date_override_off: "STAFF_DATE_UNAVAILABLE",
  outside_staff_hours: "OUTSIDE_STAFF_HOURS",
  outside_business_hours: "OUTSIDE_BUSINESS_HOURS",
  fully_blocked: "TIME_BLOCKED"
};

function covers(periods: readonly DayPeriod[], window: DayPeriod): boolean {
  return periods.some(
    (period) => window.startMinute >= period.startMinute && window.endMinute <= period.endMinute
  );
}

/** Whether a booking window fits entirely inside one resolved availability period. */
export function coversWindow(availability: EffectiveAvailability, window: DayPeriod): boolean {
  if (!availability.available) return false;
  return covers(availability.periods, window);
}

/**
 * Why one specific booking window is refused, or null when it is not.
 *
 * `coversWindow` answers yes or no; a booking route has to tell an operator WHICH of the five
 * restrictions it walked into, and the five read very differently on the screen. Deriving that
 * outside this module would mean a second copy of the precedence, which is the exact duplication
 * the file exists to prevent - so the attribution lives here, reading the stage-by-stage sets the
 * resolver already computed rather than re-resolving anything.
 *
 * A whole-day verdict is reported as it stands: a closed salon or a `working = false` date is a
 * fact about the day, not about the window. Otherwise the window is tested against each stage in
 * precedence order, and the FIRST stage that does not contain it is the answer. Order matters:
 * a 20:00 booking on a day whose salon shuts at 18:00 and whose groomer finishes at 17:00 is
 * outside the groomer's hours first, and saying "the salon is closed then" would send an operator
 * to edit the wrong grid.
 *
 * `fully_blocked` is the residual, and its wire code (`TIME_BLOCKED`) is the accurate one: the
 * window survived the staff hours and the salon hours, so the only thing left that can have
 * removed it is step 5. Note that the reason names a PARTIAL overlap here as readily as a day
 * blocked end to end - a block that clips one minute of the window still refuses it.
 */
export function refuseWindow(
  availability: EffectiveAvailability,
  window: DayPeriod
): AvailabilityReason | null {
  if (!availability.available) return availability.reason;
  if (covers(availability.periods, window)) return null;
  if (!covers(availability.staffPeriods, window)) return "outside_staff_hours";
  if (!covers(availability.boundedPeriods, window)) return "outside_business_hours";
  return "fully_blocked";
}

/**
 * Whether `availabilityOverride` - "book them anyway" - may bypass this refusal.
 *
 * TWO REASONS ARE NOT BYPASSABLE, and they are not the same kind of not-bypassable.
 *
 *   `location_closed`    a fact about the PREMISES. Step 1 is terminal, and someone with the
 *                        override permission is making a judgement about a groomer's hours, which
 *                        cannot make an unstaffed building open.
 *   `date_override_off`  a fact about THIS EMPLOYEE ON THIS DATE, stated explicitly by whoever
 *                        wrote the `employee_date_availability` row. It outranks an ordinary-hours
 *                        override because it is not an ordinary-hours restriction: the weekday
 *                        grid says what someone usually does, and this says they are not there
 *                        that day. Pawsh has no capability that forces past it, deliberately - an
 *                        emergency override of an explicit date-level unavailability is a separate
 *                        design, not a flag reused.
 *
 * The remaining three are exactly what the override has always been able to bypass, so a workspace
 * with no `employee_date_availability` rows behaves as it did before this was wired in.
 */
export function availabilityOverrideMayBypass(reason: AvailabilityReason): boolean {
  return reason !== "location_closed" && reason !== "date_override_off";
}
