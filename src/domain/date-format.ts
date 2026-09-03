import type { DateFormat, HourFormat } from "@pawsh/domain";

/**
 * Server-rendered dates and times, in the shape the workspace chose.
 *
 * WHY THIS EXISTS. Four places on the server put a date in front of a human, and until now all
 * four hard-coded the `en-US` locale: the report-card preview page, the report-card email, and the
 * appointment and rabies-expiry bodies the engagement worker generates. `Intl.DateTimeFormat`
 * given `"en-US"` produces month-before-day and a 12-hour clock unconditionally, so a salon that
 * sets DD/MM/YYYY on the settings screen still received "September 2, 2026 at 3:30 PM" in every
 * email it sent. A preference that changes nothing is worse than no preference: the operator has
 * been told the product does something it does not.
 *
 * WHY THE PATTERN IS ASSEMBLED RATHER THAN DELEGATED TO A LOCALE. The obvious shortcut is to pick
 * `"en-GB"` for DD/MM and `"en-US"` for MM/DD and let ICU lay it out. That couples the salon's
 * choice to two locales' worth of unrelated decisions - separators, month names, whether a comma
 * appears before the time, the space before "PM", and CLDR revisions changing any of them between
 * Node versions. The operator picked an ordering and an hour convention, and those are the only
 * two things that may vary. So `Intl.DateTimeFormat` is used ONLY to resolve the instant into
 * numeric parts in the correct time zone - which is the one thing it must be trusted for, because
 * that is real calendar arithmetic - and this module lays the parts out itself. `hourCycle:"h23"`
 * makes the extraction unambiguous; the 12-hour conversion happens here, once, where it can be
 * read.
 *
 * WHY NOT IN `@pawsh/domain`. That package must run on Hermes, whose reduced ICU does not reliably
 * provide `Intl.DateTimeFormat` - the same reason `time.ts` is server-side. The clients format
 * their own dates from the `dateFormat` and `hourFormat` that `/api/me` reports.
 *
 * THE WEEKDAY IS KEPT where the previous formatter had one. "Tuesday, 02/09/2026 at 15:30" still
 * honours DD/MM/YYYY and a 24-hour clock exactly; the weekday is not part of either choice, and
 * dropping it would quietly make appointment notifications harder to read as a side effect of a
 * formatting change nobody asked for. The weekday name is English because every other word in
 * these messages is - this is a date-format setting, not a localisation feature, and pretending
 * otherwise by translating one token would be the misleading half-measure.
 */
export interface DateTimePreferences {
  dateFormat: DateFormat;
  hourFormat: HourFormat;
}

/** What every workspace behaved as before 0047, so a caller with no row still formats sensibly. */
export const defaultDateTimePreferences: DateTimePreferences = {
  dateFormat: "MM/DD/YYYY", hourFormat: "12"
};

const weekdayNames = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
] as const;

interface Parts {
  year: number; month: number; day: number; hour: number; minute: number; weekday: number;
}

/**
 * The instant resolved into wall-clock parts in `timeZone`.
 *
 * `weekday:"short"` is requested as a name and mapped back to an index rather than read as a
 * number, because `Intl` has no numeric weekday part. The English short names are the ones
 * `en-US` is guaranteed to emit, and the lookup is total for the seven it can produce.
 */
function partsAt(instant: Date, timeZone: string): Parts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short"
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const shortNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(value("year")), month: Number(value("month")), day: Number(value("day")),
    hour: Number(value("hour")) % 24, minute: Number(value("minute")),
    weekday: Math.max(0, shortNames.indexOf(value("weekday")))
  };
}

const pad = (value: number, width = 2) => value.toString().padStart(width, "0");

function layOutDate(parts: Pick<Parts, "year" | "month" | "day">, format: DateFormat): string {
  const month = pad(parts.month);
  const day = pad(parts.day);
  const year = pad(parts.year, 4);
  return format === "DD/MM/YYYY" ? `${day}/${month}/${year}` : `${month}/${day}/${year}`;
}

function layOutTime(parts: Pick<Parts, "hour" | "minute">, format: HourFormat): string {
  const minute = pad(parts.minute);
  if (format === "24") return `${pad(parts.hour)}:${minute}`;
  // Midnight and noon are the two the modulo gets wrong on its own: 0 and 12 both map to 12, with
  // the meridiem doing the distinguishing.
  const hour = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  return `${hour}:${minute} ${parts.hour < 12 ? "AM" : "PM"}`;
}

/** A calendar date with no time, in the workspace's ordering: "09/02/2026" / "02/09/2026". */
export function formatPreferredDate(
  instant: Date, timeZone: string, preferences: DateTimePreferences
): string {
  return layOutDate(partsAt(instant, timeZone), preferences.dateFormat);
}

/**
 * A `YYYY-MM-DD` string in the workspace's ordering, without going near a time zone.
 *
 * `vaccination_expires_on` and the scheduling `localDate` are calendar dates, not instants. The
 * existing code turned the first into a `Date` anchored at noon UTC purely to survive being
 * formatted, which is a workaround for treating a date as an instant. There is nothing to
 * convert here, so nothing is: the three fields are reordered and returned.
 */
export function formatPreferredLocalDate(
  localDate: string, preferences: DateTimePreferences
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return localDate;
  const [, year, month, day] = match;
  return preferences.dateFormat === "DD/MM/YYYY"
    ? `${day}/${month}/${year}` : `${month}/${day}/${year}`;
}

/**
 * The full "when" line: "Tuesday, 09/02/2026 at 3:30 PM" or "Tuesday, 02/09/2026 at 15:30".
 *
 * This replaces `dateStyle:"full", timeStyle:"short"` at all four sites. The weekday and the
 * "at" survive from that shape; the date and the clock now come from the workspace.
 */
export function formatPreferredDateTime(
  instant: Date, timeZone: string, preferences: DateTimePreferences
): string {
  const parts = partsAt(instant, timeZone);
  return `${weekdayNames[parts.weekday]}, ${layOutDate(parts, preferences.dateFormat)}`
    + ` at ${layOutTime(parts, preferences.hourFormat)}`;
}

/**
 * Narrows whatever came out of the database to the two tuples.
 *
 * The columns are `not null` with check constraints, so this cannot fire for a row written through
 * a migration or the API. It exists because the worker and the report-card queries read these as
 * plain strings, and a value that somehow sat outside the set should degrade to the previous
 * behaviour rather than reach `layOutDate` and produce something unreadable.
 */
export function dateTimePreferences(row: {
  dateFormat?: string | null; hourFormat?: string | null;
} | null | undefined): DateTimePreferences {
  return {
    dateFormat: row?.dateFormat === "DD/MM/YYYY" ? "DD/MM/YYYY" : "MM/DD/YYYY",
    hourFormat: row?.hourFormat === "24" ? "24" : "12"
  };
}
