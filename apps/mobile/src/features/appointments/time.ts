/**
 * Wall-clock formatting for a salon's local time.
 *
 * Every time shown in this app is derived from `scheduledLocalStart`, the naive local timestamp
 * the API already resolved against the location's timezone, rather than from the UTC instant plus
 * `Intl.DateTimeFormat({ timeZone })`. Hermes ships a reduced ICU and its named-timezone support
 * is not dependable across Android versions, and a groomer reading "9:00" for a 10:00 appointment
 * is worse than any amount of formatting elegance. The month and weekday names are fixed English
 * for the same reason: the product's vocabulary is English throughout.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export interface WallTime {
  /** `YYYY-MM-DD` */
  date: string;
  hour: number;
  minute: number;
}

export function parseLocalDateTime(value: string | null | undefined): WallTime | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value));
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return {
    date: `${year}-${month}-${day}`,
    hour: Number(hour),
    minute: Number(minute)
  };
}

export function formatClock(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute).padStart(2, "0")} ${period}`;
}

/** `9:00 – 10:30 AM`, stating the meridiem once when both ends share it. */
export function formatRange(start: WallTime, durationMinutes: number): string {
  const total = start.hour * 60 + start.minute + Math.max(0, durationMinutes);
  const endHour = Math.floor(total / 60) % 24;
  const endMinute = total % 60;
  const startText = formatClock(start.hour, start.minute);
  const endText = formatClock(endHour, endMinute);
  const sharesPeriod = startText.slice(-2) === endText.slice(-2) && durationMinutes < 12 * 60;
  return sharesPeriod ? `${startText.slice(0, -3)} – ${endText}` : `${startText} – ${endText}`;
}

function weekdayIndex(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
}

/** `Tuesday, August 26` */
export function formatLongDate(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${WEEKDAYS[weekdayIndex(date)]}, ${MONTHS[(month ?? 1) - 1]} ${day}`;
}

/** `Tue, Aug 26` */
export function formatShortDate(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${WEEKDAYS_SHORT[weekdayIndex(date)]}, ${(MONTHS[(month ?? 1) - 1] ?? "").slice(0, 3)} ${day}`;
}

/** `MM/DD/YYYY`, matching how the web app prints a stored date. */
export function formatDateValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const [year, month, day] = String(value).slice(0, 10).split("-");
  if (!year || !month || !day) return null;
  return `${month}/${day}/${year}`;
}

/** The device's local calendar date as `YYYY-MM-DD`. */
export function deviceLocalDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

/** `8:42 AM`, for "last synced" and other device-clock timestamps. */
export function formatDeviceTime(value: Date): string {
  return formatClock(value.getHours(), value.getMinutes());
}
