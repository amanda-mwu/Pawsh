import { describe, expect, it } from "vitest";
import {
  dateTimePreferences, defaultDateTimePreferences, formatPreferredDate,
  formatPreferredDateTime, formatPreferredLocalDate
} from "../../src/domain/date-format.js";

/**
 * The server-rendered date, in the shape the workspace chose.
 *
 * Four places on the server put a date in front of a person and all four hard-coded `en-US`, so a
 * salon that picked DD/MM/YYYY still received "September 2, 2026 at 3:30 PM" in every email. These
 * assert the two things the setting promises - the field ordering and the clock - and the two
 * things it must not quietly change along the way: which instant is being described, and in which
 * time zone.
 */
const us = { dateFormat: "MM/DD/YYYY", hourFormat: "12" } as const;
const international = { dateFormat: "DD/MM/YYYY", hourFormat: "24" } as const;

describe("formatPreferredDateTime", () => {
  // 2 September 2026, 15:30 in Los Angeles. Chosen so the day and month cannot be confused with
  // each other: a 02/09 versus 09/02 mix-up is exactly the defect the ordering setting is about,
  // and a date like the 11th of November would hide it.
  const instant = new Date("2026-09-02T22:30:00.000Z");
  const zone = "America/Los_Angeles";

  it("lays the date out month-first for a workspace that chose it", () => {
    expect(formatPreferredDateTime(instant, zone, us)).toBe("Wednesday, 09/02/2026 at 3:30 PM");
  });

  it("lays the date out day-first, on a 24-hour clock, for a workspace that chose that", () => {
    expect(formatPreferredDateTime(instant, zone, international))
      .toBe("Wednesday, 02/09/2026 at 15:30");
  });

  it("honours the two settings independently", () => {
    // They are separate columns and separate choices; a salon may want DD/MM with a 12-hour clock.
    expect(formatPreferredDateTime(instant, zone, { dateFormat: "DD/MM/YYYY", hourFormat: "12" }))
      .toBe("Wednesday, 02/09/2026 at 3:30 PM");
    expect(formatPreferredDateTime(instant, zone, { dateFormat: "MM/DD/YYYY", hourFormat: "24" }))
      .toBe("Wednesday, 09/02/2026 at 15:30");
  });

  it("still resolves the instant in the appointment's own time zone", () => {
    // The setting changes the LAYOUT and nothing else. The same instant is a different calendar
    // day in Auckland, and getting that wrong would tell a client the wrong day for their
    // appointment - a far worse failure than any ordering.
    expect(formatPreferredDateTime(instant, "Pacific/Auckland", us))
      .toBe("Thursday, 09/03/2026 at 10:30 AM");
    expect(formatPreferredDateTime(instant, "UTC", international))
      .toBe("Wednesday, 02/09/2026 at 22:30");
  });

  it("survives a daylight-saving transition", () => {
    // 08:30 UTC on the second Sunday in March 2026 is 01:30 PST, before the spring-forward at
    // 02:00; 11:30 UTC is 04:30 PDT, after it. Both must read as the local wall clock, because
    // the offset moved between them.
    expect(formatPreferredDateTime(new Date("2026-03-08T09:30:00.000Z"), zone, us))
      .toBe("Sunday, 03/08/2026 at 1:30 AM");
    expect(formatPreferredDateTime(new Date("2026-03-08T11:30:00.000Z"), zone, us))
      .toBe("Sunday, 03/08/2026 at 4:30 AM");
  });

  it("writes midnight and noon the way a person does", () => {
    // The two the modulo gets wrong on its own: 0 and 12 both map to 12, and only the meridiem
    // distinguishes them. "0:30 AM" and "12:30 AM" for the same instant is the classic bug.
    expect(formatPreferredDateTime(new Date("2026-09-02T07:30:00.000Z"), zone, us))
      .toBe("Wednesday, 09/02/2026 at 12:30 AM");
    expect(formatPreferredDateTime(new Date("2026-09-02T19:00:00.000Z"), zone, us))
      .toBe("Wednesday, 09/02/2026 at 12:00 PM");
    // And midnight on a 24-hour clock is 00:30, not 24:30 and not 12:30.
    expect(formatPreferredDateTime(new Date("2026-09-02T07:30:00.000Z"), zone, international))
      .toBe("Wednesday, 02/09/2026 at 00:30");
  });

  it("zero-pads both fields so a column of dates lines up", () => {
    expect(formatPreferredDateTime(new Date("2026-01-05T18:00:00.000Z"), "UTC", us))
      .toBe("Monday, 01/05/2026 at 6:00 PM");
  });
});

describe("formatPreferredDate", () => {
  it("writes the calendar date alone, in the chosen order", () => {
    const instant = new Date("2026-09-02T22:30:00.000Z");
    expect(formatPreferredDate(instant, "America/Los_Angeles", us)).toBe("09/02/2026");
    expect(formatPreferredDate(instant, "America/Los_Angeles", international)).toBe("02/09/2026");
  });
});

describe("formatPreferredLocalDate", () => {
  it("reorders a calendar date without going near a time zone", () => {
    // `vaccination_expires_on` is a `date` and the scheduling `localDate` is a `YYYY-MM-DD` string.
    // Neither is an instant, so neither may be shifted by one. The previous code anchored the
    // first at noon UTC purely to survive an instant formatter, which is a workaround for treating
    // a date as a moment.
    expect(formatPreferredLocalDate("2026-09-02", us)).toBe("09/02/2026");
    expect(formatPreferredLocalDate("2026-09-02", international)).toBe("02/09/2026");
    // A date that would shift a day under any UTC anchoring: the first of the month.
    expect(formatPreferredLocalDate("2026-01-01", international)).toBe("01/01/2026");
    expect(formatPreferredLocalDate("2026-12-31", us)).toBe("12/31/2026");
  });

  it("returns anything unrecognisable untouched rather than mangling it", () => {
    // These strings come from a `date` column and a validated request field, so this cannot fire
    // in practice. If it ever did, showing the raw value beats showing a confidently wrong one.
    expect(formatPreferredLocalDate("not-a-date", us)).toBe("not-a-date");
    expect(formatPreferredLocalDate("", us)).toBe("");
  });
});

describe("dateTimePreferences", () => {
  it("reads the two columns off a row", () => {
    expect(dateTimePreferences({ dateFormat: "DD/MM/YYYY", hourFormat: "24" }))
      .toEqual(international);
  });

  it("falls back to what every workspace behaved as before the columns existed", () => {
    // The columns are `not null` with check constraints, so this cannot fire for a row written by
    // a migration or the API. It matters for the left-joined and absent cases: a value outside the
    // set must degrade to the previous behaviour rather than reach the layout code.
    expect(dateTimePreferences(null)).toEqual(defaultDateTimePreferences);
    expect(dateTimePreferences(undefined)).toEqual(defaultDateTimePreferences);
    expect(dateTimePreferences({})).toEqual(defaultDateTimePreferences);
    expect(dateTimePreferences({ dateFormat: "YYYY-MM-DD", hourFormat: "36" }))
      .toEqual(defaultDateTimePreferences);
    expect(defaultDateTimePreferences).toEqual(us);
  });

  it("takes the two settings apart rather than treating them as one style", () => {
    expect(dateTimePreferences({ dateFormat: "DD/MM/YYYY", hourFormat: "12" }))
      .toEqual({ dateFormat: "DD/MM/YYYY", hourFormat: "12" });
    expect(dateTimePreferences({ dateFormat: "MM/DD/YYYY", hourFormat: "24" }))
      .toEqual({ dateFormat: "MM/DD/YYYY", hourFormat: "24" });
  });
});
