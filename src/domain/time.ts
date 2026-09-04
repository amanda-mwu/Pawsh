/**
 * Wall-clock time, resolved against a salon's timezone rather than the machine's.
 *
 * Everything here is host-independent on purpose: `Intl.DateTimeFormat` with an explicit
 * `timeZone` and `Date.UTC` arithmetic, never `new Date("2026-09-11T12:30")`, which reads a
 * zone-less string in whatever timezone the Node process happens to be running in.
 *
 * ------------------------------------------------------------------------------------------
 * HOW A LOCAL WALL CLOCK IS PERSISTED. Read this before writing `scheduled_local_start` or any
 * other `timestamp without time zone` column.
 *
 * The instant (`start_at`, `timestamptz`) is the authority. The naive column beside it is a
 * DERIVED denormalisation that exists so the calendar can range-scan on a local date, and it
 * must be derived IN SQL from the instant and the row's own `scheduling_timezone`:
 *
 *     scheduled_local_start = ${startAt}::timestamptz at time zone ${resolved.timeZone}
 *
 * NEVER by binding the operator's local string straight into the column. postgres.js keys its
 * serializers on the parameter type the SERVER describes, and 1082/1114/1184 all resolve to
 * `x => (x instanceof Date ? x : new Date(x)).toISOString()` - so a bare `${input.localStart}`
 * landing in a `timestamp` column is parsed as a local time on the API HOST and stored as the
 * UTC clock. On a Pacific host a 12:30 booking persisted as 19:30. The bug is invisible on a
 * UTC host, which is why it survived: `start_at` stayed correct and the calendar, which reads
 * `start_at at time zone scheduling_timezone`, went on rendering the right time over a wrong row.
 *
 * `(${value}::text)::timestamp` is the other safe form - the explicit `::text` makes the server
 * describe the parameter as text, so the string reaches Postgres unconverted and Postgres parses
 * it. `completeSchedulingRequest` uses that one; `scripts/seed-qa.ts` uses it too. Deriving from
 * the instant is preferred where the instant is at hand, because it leaves one source of truth
 * instead of two that can disagree.
 *
 * `0051_local_wall_clock_integrity.sql` holds both columns to that rule in the database.
 * ------------------------------------------------------------------------------------------
 */

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type Disambiguation = "earlier" | "later";

export class WallTimeError extends Error {
  constructor(public readonly code: "INVALID_LOCAL_TIME" | "NONEXISTENT_LOCAL_TIME" | "AMBIGUOUS_LOCAL_TIME" | "INVALID_TIMEZONE") {
    super(code);
  }
}

function formatter(timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    });
  } catch {
    throw new WallTimeError("INVALID_TIMEZONE");
  }
}

function partsAt(date: Date, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year:value("year"), month:value("month"), day:value("day"), hour:value("hour") % 24, minute:value("minute") };
}

function validDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateTimeZone(timeZone: string): string {
  formatter(timeZone).format(new Date(0));
  return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
}

export function parseLocalDateTime(value: string) {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) throw new WallTimeError("INVALID_LOCAL_TIME");
  const [,y,m,d,h,min] = match;
  const result = { year:Number(y), month:Number(m), day:Number(d), hour:Number(h), minute:Number(min) };
  if (!validDate(result.year,result.month,result.day) || result.hour > 23 || result.minute > 59) {
    throw new WallTimeError("INVALID_LOCAL_TIME");
  }
  return result;
}

export function resolveWallTime(localStart: string, timeZone: string, disambiguation?: Disambiguation) {
  const local = parseLocalDateTime(localStart);
  const naive = Date.UTC(local.year,local.month-1,local.day,local.hour,local.minute);
  const offsets = new Set<number>();
  for (let delta = -48; delta <= 48; delta += 6) {
    const instant = new Date(naive + delta * 3_600_000);
    const represented = partsAt(instant,timeZone);
    offsets.add((Date.UTC(represented.year,represented.month-1,represented.day,represented.hour,represented.minute)-instant.getTime())/60_000);
  }
  const candidates = [...offsets].map((offsetMinutes) => ({
    instant:new Date(naive-offsetMinutes*60_000), offsetMinutes
  })).filter(({instant}) => {
    const represented=partsAt(instant,timeZone);
    return Object.keys(local).every((key) => represented[key as keyof typeof represented] === local[key as keyof typeof local]);
  }).sort((a,b)=>a.instant.getTime()-b.instant.getTime());
  if (!candidates.length) throw new WallTimeError("NONEXISTENT_LOCAL_TIME");
  if (candidates.length > 1 && !disambiguation) throw new WallTimeError("AMBIGUOUS_LOCAL_TIME");
  const selected = candidates.length === 1 || disambiguation === "earlier" ? candidates[0]! : candidates.at(-1)!;
  return { ...selected, timeZone:validateTimeZone(timeZone), disambiguation:candidates.length > 1 ? disambiguation! : null };
}

export function formatWallTime(instant: Date | string, timeZone: string): string {
  const p=partsAt(new Date(instant),timeZone);
  return `${p.year.toString().padStart(4,"0")}-${p.month.toString().padStart(2,"0")}-${p.day.toString().padStart(2,"0")}T${p.hour.toString().padStart(2,"0")}:${p.minute.toString().padStart(2,"0")}`;
}

export function localDateBounds(localDate: string, timeZone: string) {
  const match=LOCAL_DATE.exec(localDate);
  if(!match) throw new WallTimeError("INVALID_LOCAL_TIME");
  const [,y,m,d]=match;
  const year=Number(y),month=Number(m),day=Number(d);
  if(!validDate(year,month,day)) throw new WallTimeError("INVALID_LOCAL_TIME");
  const next=new Date(Date.UTC(year,month-1,day+1));
  const nextDate=`${next.getUTCFullYear().toString().padStart(4,"0")}-${(next.getUTCMonth()+1).toString().padStart(2,"0")}-${next.getUTCDate().toString().padStart(2,"0")}`;
  return { from:resolveWallTime(`${localDate}T00:00`,timeZone).instant, to:resolveWallTime(`${nextDate}T00:00`,timeZone).instant };
}

export function localDateForInstant(instant: Date, timeZone: string) {
  return formatWallTime(instant,timeZone).slice(0,10);
}
