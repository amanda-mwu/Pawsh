import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHAT ANOTHER OPERATOR DID REACHES THE CALENDAR WITHOUT ANYBODY PRESSING ANYTHING.
 *
 * The grid was read when it was opened and again whenever THIS session changed something. The
 * only door for somebody else's change was `visibilitychange`, so a groomer who kept the calendar
 * in front of her the whole time never saw the owner's cancellation until she navigated away and
 * back. Three doors now: the tab coming back (the session resume, unchanged), the window
 * regaining focus (the calendar's own period read), and a timer while the calendar is on screen
 * (the same read, once a minute).
 *
 * These run the real scheduler - `calendarLiveEligible`, `calendarLiveTick`, `startCalendarLive`,
 * `stopCalendarLive`, `resumeSession` and the three listeners that wire them - against fake timers
 * and a recorded `loadCalendarWeek`, so what is asserted is WHEN the calendar's read went out and
 * when it deliberately did not.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `CALENDAR_LIVE_INTERVAL_MS` doubled, or the timer never started
 *       "reads the period once a minute while the calendar is on screen" fails.
 *   `calendarLiveEligible` returning true unconditionally
 *       every case in "stands down" fails: the grid would be repainted under a drag, under an
 *       open menu, on a view that is not the calendar, or in a hidden tab.
 *   `stopCalendarLive` not called on hidden
 *       "pauses while hidden and resumes on visible" fails - a hidden tab keeps reading.
 *   the focus listener calling `resumeSession` (fourteen reads) instead of the tick
 *       "focus reads the calendar period, and only that" fails.
 *   the coalescing window removed
 *       "a focus inside a resume's window is the same return, not a second read" fails.
 *   `calendarLiveBusy` dropped
 *       "a tick still in the air is not doubled" fails.
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/** The scheduler and its wiring, verbatim, up to the invite/reset branch that follows it. */
const LIVENESS = slice("const CALENDAR_LIVE_INTERVAL_MS=", "\nif (inviteToken || resetToken) {");

interface Harness {
  /** Every `loadCalendarWeek()` the scheduler made, in order, as the time it went out. */
  periodReads: number[];
  /** Every `refresh()` a resume made. */
  refreshes: number;
  /** Every `/api/me` a resume re-read. */
  meReads: number;
  toasts: string[];
  fire(event: "visibilitychange" | "focus"): void;
  document: { visibilityState: string; body: { dataset: { view?: string } } };
  state: { me: unknown };
  /** What the grid is doing right now, for the eligibility gate. */
  drag: { active: boolean };
  open: { popover: boolean; filter: boolean };
  /** Make the next `loadCalendarWeek()` hang until `release()` is called, or fail. */
  hold(): { release(): void };
  failNext(): void;
  calendarLiveEligible(): boolean;
}

function harness(): Harness {
  const listeners: Record<string, Array<() => void>> = {};
  const document = {
    visibilityState: "visible",
    body: { dataset: { view: "calendar" } as { view?: string } },
    addEventListener(name: string, handler: () => void) { (listeners[name] ??= []).push(handler); }
  };
  const window = {
    setInterval: (task: () => void, ms: number) => setInterval(task, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    addEventListener(name: string, handler: () => void) { (listeners[name] ??= []).push(handler); }
  };
  const state = { me: { isOwner: true } as unknown };
  const drag = { active: false };
  const open = { popover: false, filter: false };
  const periodReads: number[] = [];
  const toasts: string[] = [];
  const counters = { refreshes: 0, meReads: 0 };
  let held: { promise: Promise<void>; release(): void } | null = null;
  let failNext = false;

  const loadCalendarWeek = async (): Promise<void> => {
    periodReads.push(Date.now());
    if (failNext) { failNext = false; throw new Error("the period read failed"); }
    if (held) { const pending = held; held = null; await pending.promise; }
  };
  const $ = (selector: string): unknown => {
    if (selector.startsWith(".calendar-action-popover")) return open.popover ? {} : null;
    if (selector.startsWith("#groomer-filter")) return open.filter ? {} : null;
    return null;
  };
  const scope: Record<string, unknown> = {
    document, globalThis: window, state, $,
    loadCalendarWeek,
    api: async (path: string) => { if (path === "/api/me") counters.meReads += 1; return { isOwner: true }; },
    applyPermissions: () => {},
    refresh: async () => { counters.refreshes += 1; },
    bootstrap: async () => {},
    runDetached: (task: () => Promise<void>) => { Promise.resolve().then(task).catch((error: Error) => toasts.push(error.message)); }
  };
  // `calendarDrag` is a module-level `let` in app.js that the scheduler reads by name; the
  // harness declares it beside the slice and hands back a setter.
  const names = Object.keys(scope);
  const factory = new Function(
    ...names,
    [
      "let calendarDrag=null;",
      LIVENESS,
      "return {calendarLiveEligible, sync: (active) => { calendarDrag = active ? {} : null; }};"
    ].join("\n")
  ) as (...args: unknown[]) => { calendarLiveEligible(): boolean; sync(active: boolean): void };
  const module = factory(...names.map((name) => scope[name]));

  return {
    periodReads, toasts,
    get refreshes() { return counters.refreshes; },
    get meReads() { return counters.meReads; },
    fire(event) { module.sync(drag.active); for (const handler of listeners[event] ?? []) handler(); },
    document, state, drag, open,
    hold() {
      let release = (): void => {};
      const promise = new Promise<void>((resolve) => { release = resolve; });
      held = { promise, release };
      return { release };
    },
    failNext() { failNext = true; },
    calendarLiveEligible() { module.sync(drag.active); return module.calendarLiveEligible(); }
  };
}

/** Let the microtasks behind a detached task settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => { vi.useFakeTimers({ now: new Date("2026-09-17T09:00:00Z") }); });
afterEach(() => { vi.useRealTimers(); });

describe("the calendar reads its period once a minute while it is on screen", () => {
  it("reads the period once a minute, and nothing before the first minute is up", async () => {
    const app = harness();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(app.periodReads).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(app.periodReads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(app.periodReads).toHaveLength(3);
    // Nothing else went out: no session re-read, no workspace refresh, and nothing was said.
    expect(app.meReads).toBe(0);
    expect(app.refreshes).toBe(0);
    expect(app.toasts).toEqual([]);
  });

  it("stands down while the operator is doing something the repaint would disturb", async () => {
    const app = harness();
    expect(app.calendarLiveEligible()).toBe(true);

    app.document.body.dataset.view = "customers";
    expect(app.calendarLiveEligible()).toBe(false);
    app.document.body.dataset.view = "calendar";

    app.drag.active = true;
    expect(app.calendarLiveEligible()).toBe(false);
    app.drag.active = false;

    app.open.popover = true;
    expect(app.calendarLiveEligible()).toBe(false);
    app.open.popover = false;

    app.open.filter = true;
    expect(app.calendarLiveEligible()).toBe(false);
    app.open.filter = false;

    app.state.me = null;
    expect(app.calendarLiveEligible()).toBe(false);
    app.state.me = { isOwner: true };

    app.document.visibilityState = "hidden";
    expect(app.calendarLiveEligible()).toBe(false);
    app.document.visibilityState = "visible";
    expect(app.calendarLiveEligible()).toBe(true);

    // And a tick that lands while ineligible reads nothing rather than reading later.
    app.drag.active = true;
    app.fire("focus");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.periodReads).toHaveLength(0);
  });

  it("pauses while hidden and resumes on visible, with the session re-read once on the way back", async () => {
    const app = harness();
    app.document.visibilityState = "hidden";
    app.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(app.periodReads).toHaveLength(0);

    app.document.visibilityState = "visible";
    app.fire("visibilitychange");
    await settle();
    // The resume: the session and the workspace, exactly what the tab's return did before.
    expect(app.meReads).toBe(1);
    expect(app.refreshes).toBe(1);
    // And the timer is running again from here.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.periodReads).toHaveLength(1);
  });

  it("focus reads the calendar period, and only that", async () => {
    const app = harness();
    app.fire("focus");
    await settle();
    expect(app.periodReads).toHaveLength(1);
    expect(app.meReads).toBe(0);
    expect(app.refreshes).toBe(0);
  });

  it("a focus inside a resume's window is the same return to the tab, not a second read", async () => {
    const app = harness();
    app.fire("visibilitychange");
    await settle();
    expect(app.refreshes).toBe(1);
    // The focus that arrives in the same instant as the tab becoming visible.
    app.fire("focus");
    await settle();
    expect(app.periodReads).toHaveLength(0);
    // Five seconds on, a focus is a focus.
    await vi.advanceTimersByTimeAsync(5_000);
    app.fire("focus");
    await settle();
    expect(app.periodReads).toHaveLength(1);
  });

  it("a tick still in the air is not doubled, and a tick that fails says nothing", async () => {
    const app = harness();
    const first = app.hold();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.periodReads).toHaveLength(1);
    // The next minute arrives while the first read is still out: nothing goes out on top of it.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.periodReads).toHaveLength(1);
    first.release();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.periodReads).toHaveLength(2);

    // A read that fails is nobody's error to see: the operator asked for nothing, the grid keeps
    // what it has, and the minute after tries again.
    app.failNext();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.periodReads).toHaveLength(3);
    expect(app.toasts).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.periodReads).toHaveLength(4);
  });
});
