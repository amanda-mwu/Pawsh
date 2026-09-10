import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE CALENDAR RELOADS THE PERIOD IT IS SHOWING, AND NOTHING ELSE MAY DECIDE THAT FOR IT.
 *
 * `refresh()` used to reload a window of its own — `localDate=<today>&days=8`, fixed, anchored on
 * the clock — and then overwrite `state.appointments` wholesale. Every one of its thirty-odd
 * callers therefore emptied the grid for an operator working outside those eight days: a drag that
 * SUCCEEDED, a check-in, a refund, a staff edit, or merely switching browser tabs and back, which
 * is `visibilitychange`. The grid stayed drawn with nothing on it, and pressing Today appeared to
 * repair it only because Today navigates back INTO the window `refresh()` had loaded.
 *
 * These run the real `refresh()` and the real `loadCalendarWeek()` against a recording `api`, so
 * what is asserted is the QUERY STRING that went out and the cards that survived — not a
 * description of either. `calendarRangeQueries`, `weekStart` and `dateShift` are the client's own,
 * sliced in rather than reimplemented, because a test that recomputed the window would agree with
 * itself forever.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `calendarDisplayRange()` → `{start:businessDate(),days:8,blocks:true}` in `refresh`
 *       the defect, restored. "a refresh reads the week on screen" fails in all three view modes,
 *       and "the cards on a far week survive a refresh" fails with an empty grid.
 *
 *   dropping the `calendarReadCurrent(calendarRead)` guard in `refresh`
 *       a refresh in flight overwrites the period the operator navigated to. Both
 *       "the newer read owns the grid" assertions fail.
 *
 *   `if(!calendarReadCurrent(token))return;` → nothing, in `loadCalendarWeek`
 *       the same race in the other direction. "a superseded week does not paint" fails.
 *
 *   `applyCalendarPeriod` not writing `monthAppointments`
 *       a month grid keeps drawing the cards it was opened with. "a month refresh replaces the
 *       month's own cache" fails.
 *
 * Each was applied to `public/app.js`, run against this file, and reverted.
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/** Calendar dates as the client does them — the real chunking, the real week arithmetic. */
const DATES = slice("function dateAt(value){", "\nfunction calendarPreferenceKey(){")
  + slice("function weekStart(value){", "\nfunction appointmentLocalValue(");
/**
 * The window, both reads, the serial that decides which read owns the grid, and the write itself.
 * `calendarRangeQueries` is included because the query string is the assertion.
 */
const RANGE = slice("function calendarRangeQueries(start,days){", "\nasync function loadCalendarWeek(");
/** The calendar's own loader, which is the other half of every race below. */
const LOAD_WEEK = slice(
  "async function loadCalendarWeek(start=state.calendar.weekStart){",
  "\nasync function openCalendarView(){"
);
/** The read every one of the thirty-odd callers goes through. */
const REFRESH = slice("async function refresh() {", "\nfunction schedulingZone(){");

interface Appointment { id: string }
interface Call { url: string; settle(payload: unknown): void }

interface Client {
  refresh(): Promise<void>;
  loadCalendarWeek(start?: string): Promise<void>;
  state: {
    appointments: Appointment[];
    blockedTimes: unknown[];
    calendar: {
      view: string; weekStart: string | null; selectedDate: string | null; month: string | null;
      monthAppointments: Appointment[]; selectedGroomerIds: Set<string> | null;
      preferences: { firstDay: string };
    };
  };
  /** Every request that went out, in order. */
  urls: string[];
  /** The calendar reads still in the air, oldest first. */
  pending: Call[];
  /** Settles the first unsettled read whose URL contains `fragment`. */
  settle(fragment: string, payload: unknown): void;
  renders: number;
}

/**
 * The client, with the calendar reads held open.
 *
 * `/api/appointments` and `/api/blocked-times` return promises the TEST settles, which is what
 * makes "the operator navigated while this was in the air" expressible at all. Everything else
 * `refresh()` asks for answers immediately and is not what any of this is about.
 */
function client(today = "2026-09-10"): Client {
  const urls: string[] = [];
  const pending: Call[] = [];

  const api = (url: string): Promise<unknown> => {
    urls.push(url);
    if (!url.startsWith("/api/appointments") && !url.startsWith("/api/blocked-times")) {
      return Promise.resolve(url === "/api/customers?paged=true&page=1&pageSize=20"
        ? { items: [], total: 0, page: 1, pageSize: 20 } : []);
    }
    return new Promise((resolve) => { pending.push({ url, settle: resolve }); });
  };

  const state = {
    me: { isOwner: true, permissions: [], business: { timezone: "UTC" } },
    pets: [], dogBreeds: [], petTypes: [], businessHours: [{ weekday: 1 }],
    appointments: [] as Appointment[], blockedTimes: [] as unknown[],
    calendar: {
      view: "week", weekStart: null as string | null, selectedDate: null as string | null,
      month: null as string | null, monthAppointments: [] as Appointment[],
      selectedGroomerIds: null as Set<string> | null, preferences: { firstDay: "sunday" }
    }
  };

  const renders = { count: 0 };
  const scope: Record<string, unknown> = {
    api, state,
    businessDate: () => today,
    calendarPreferences: () => state.calendar.preferences,
    canViewDashboard: () => false,
    loadLocations: () => Promise.resolve([]),
    loadCalendarMonth: () => Promise.resolve([]),
    appointmentLocalValue: () => `${today}T09:00`,
    renderAppointments: () => { renders.count += 1; },
    renderAccountIdentity: () => {}, renderLocationSwitcher: () => {},
    reconcileGroomerFilter: () => {}, applyPermissions: () => {},
    renderDashboard: () => {}, renderCustomersEnhanced: () => {}, renderRoles: () => {},
    renderServices: () => {}, renderReports: () => {},
    schedulingZone: () => "UTC",
    formatPrefWeekdayMonthDay: () => "",
    $: () => ({ textContent: "" })
  };

  const names = Object.keys(scope);
  const factory = new Function(
    ...names,
    [DATES, RANGE, LOAD_WEEK, REFRESH, "return {refresh,loadCalendarWeek};"].join("\n")
  ) as (...args: unknown[]) => { refresh(): Promise<void>; loadCalendarWeek(start?: string): Promise<void> };
  const module = factory(...names.map((name) => scope[name]));

  return {
    ...module,
    state: state as unknown as Client["state"],
    urls,
    pending,
    settle(fragment, payload) {
      const index = pending.findIndex((call) => call.url.includes(fragment));
      if (index < 0) throw new Error(`no read in flight matching ${fragment}; saw ${urls.join(", ")}`);
      pending.splice(index, 1)[0]!.settle(payload);
    },
    get renders() { return renders.count; }
  };
}

/** The calendar, positioned somewhere. Nothing here touches today. */
function showing(
  app: Client,
  position: { view: string; weekStart?: string; selectedDate: string; month: string }
): void {
  Object.assign(app.state.calendar, {
    view: position.view,
    weekStart: position.weekStart ?? null,
    selectedDate: position.selectedDate,
    month: position.month
  });
}

const cards = (...ids: string[]): Appointment[] => ids.map((id) => ({ id }));

describe("a refresh reads the period the calendar is showing", () => {
  it("reads the week on screen, not the eight days after today", async () => {
    const app = client("2026-09-10");
    showing(app, { view: "week", weekStart: "2026-10-04", selectedDate: "2026-10-07", month: "2026-10" });

    const done = app.refresh();
    app.settle("/api/appointments", cards("a", "b"));
    app.settle("/api/blocked-times", []);
    await done;

    expect(app.urls).toContain("/api/appointments?localDate=2026-10-04&days=7");
    expect(app.urls).toContain("/api/blocked-times?localDate=2026-10-04&days=7");
    expect(app.urls.some((url) => url.includes("localDate=2026-09-10"))).toBe(false);
  });

  it("leaves the cards of that week on the grid, which is the whole defect", async () => {
    const app = client("2026-09-10");
    showing(app, { view: "week", weekStart: "2026-10-04", selectedDate: "2026-10-07", month: "2026-10" });
    app.state.appointments = cards("a", "b");

    const done = app.refresh();
    // What the server says about Oct 4–10 — the same two visits, because nothing moved.
    app.settle("/api/appointments", cards("a", "b"));
    app.settle("/api/blocked-times", []);
    await done;

    expect(app.state.appointments.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("reads one day in day view", async () => {
    const app = client("2026-09-10");
    showing(app, { view: "day", weekStart: "2026-10-04", selectedDate: "2026-10-07", month: "2026-10" });

    const done = app.refresh();
    app.settle("/api/appointments", cards("a"));
    app.settle("/api/blocked-times", []);
    await done;

    expect(app.urls).toContain("/api/appointments?localDate=2026-10-07&days=1");
  });

  it("reads the whole month grid, in the chunks the schema caps at, and asks for no blocks", async () => {
    const app = client("2026-09-10");
    showing(app, { view: "month", selectedDate: "2026-11-15", month: "2026-11" });

    const done = app.refresh();
    // 42 cells from the Sunday before Nov 1 — two requests, because `days` is capped at 31.
    app.settle("localDate=2026-11-01&days=31", cards("a"));
    app.settle("localDate=2026-12-02&days=11", cards("b"));
    await done;

    expect(app.urls.filter((url) => url.startsWith("/api/appointments"))).toEqual([
      "/api/appointments?localDate=2026-11-01&days=31",
      "/api/appointments?localDate=2026-12-02&days=11"
    ]);
    // The month grid draws no bands, so it reads none.
    expect(app.urls.some((url) => url.startsWith("/api/blocked-times"))).toBe(false);
  });

  it("replaces the month's own cache, so a month grid is not left drawing what it opened with", async () => {
    const app = client("2026-09-10");
    showing(app, { view: "month", selectedDate: "2026-11-15", month: "2026-11" });
    app.state.calendar.monthAppointments = cards("stale");

    const done = app.refresh();
    app.settle("localDate=2026-11-01&days=31", cards("fresh"));
    app.settle("localDate=2026-12-02&days=11", []);
    await done;

    expect(app.state.calendar.monthAppointments.map((item) => item.id)).toEqual(["fresh"]);
  });

  it("keeps the today-anchored window until the calendar has been positioned at all", async () => {
    // The first refresh of a session runs before any week has been chosen, and the landing date is
    // picked out of what it returns. That case is the ONLY one still anchored on the clock.
    const app = client("2026-09-10");

    const done = app.refresh();
    app.settle("/api/appointments", []);
    app.settle("/api/blocked-times", []);
    await done;

    expect(app.urls).toContain("/api/appointments?localDate=2026-09-10&days=8");
  });
});

describe("the newer read owns the grid when two are in the air", () => {
  it("a refresh that started first does not paint over the week navigated to", async () => {
    const app = client("2026-09-10");
    showing(app, { view: "week", weekStart: "2026-10-04", selectedDate: "2026-10-07", month: "2026-10" });

    // In flight over the week the operator is leaving.
    const refreshed = app.refresh();
    // …and while it is in the air, they page forward. `loadCalendarWeek` is what every navigation
    // goes through, so this is the navigation itself, not a simulation of one.
    const navigated = app.loadCalendarWeek("2026-11-01");

    // The week they asked for answers first and paints.
    app.settle("localDate=2026-11-01&days=7", cards("november"));
    app.settle("/api/blocked-times?localDate=2026-11-01", []);
    await navigated;
    expect(app.state.appointments.map((item) => item.id)).toEqual(["november"]);

    // Then the older refresh lands, holding October. It must not be what the operator sees.
    app.settle("localDate=2026-10-04&days=7", cards("october"));
    app.settle("/api/blocked-times?localDate=2026-10-04", []);
    await refreshed;

    expect(app.state.appointments.map((item) => item.id)).toEqual(["november"]);
    expect(app.state.calendar.weekStart).toBe("2026-11-01");
  });

  it("the same when the older read answers first — the serial decides, not the order", async () => {
    const app = client("2026-09-10");
    showing(app, { view: "week", weekStart: "2026-10-04", selectedDate: "2026-10-07", month: "2026-10" });

    const refreshed = app.refresh();
    const navigated = app.loadCalendarWeek("2026-11-01");

    app.settle("localDate=2026-10-04&days=7", cards("october"));
    app.settle("/api/blocked-times?localDate=2026-10-04", []);
    await refreshed;
    // The refresh has completed and written nothing to the grid, because it no longer owns it.
    expect(app.state.appointments.map((item) => item.id)).toEqual([]);

    app.settle("localDate=2026-11-01&days=7", cards("november"));
    app.settle("/api/blocked-times?localDate=2026-11-01", []);
    await navigated;

    expect(app.state.appointments.map((item) => item.id)).toEqual(["november"]);
  });

  it("a superseded week does not paint either, so navigating twice quickly lands on the second", async () => {
    const app = client("2026-09-10");
    showing(app, { view: "week", weekStart: "2026-10-04", selectedDate: "2026-10-07", month: "2026-10" });

    const first = app.loadCalendarWeek("2026-11-01");
    const second = app.loadCalendarWeek("2026-11-08");

    app.settle("localDate=2026-11-08&days=7", cards("second"));
    app.settle("/api/blocked-times?localDate=2026-11-08", []);
    await second;

    app.settle("localDate=2026-11-01&days=7", cards("first"));
    app.settle("/api/blocked-times?localDate=2026-11-01", []);
    await first;

    expect(app.state.appointments.map((item) => item.id)).toEqual(["second"]);
  });
});
