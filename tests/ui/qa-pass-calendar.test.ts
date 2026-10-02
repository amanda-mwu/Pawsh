import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appointmentStatuses, canEnterCheckout } from "@pawsh/domain";

/**
 * THE QA PASS'S CALENDAR, DASHBOARD AND SHELL ROWS, PINNED.
 *
 * Each block runs the client's own code - sliced out of `public/app.js`, not restated - against
 * the smallest fake it needs, or reads the rule in `public/styles.css` the fix lives in. What only
 * a browser can answer (a strip's pixels, the toolbar's rows) is measured in
 * `tests/e2e/qa-pass-calendar.spec.ts`.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `.week-slot` without `border:0`                         "a week slot draws no button border"
 *   the time painting past its box / the badge shrinking    "a narrow card keeps the start time and the whole badge"
 *   cancelled visits back in the lane packing               "a cancelled visit does not take a lane from a live one"
 *   the "Now" tag back on the line                          "the Now tag sits in the time gutter"
 *   the card menu back to bordered 36px boxes               "the card menu is compact rows"
 *   the hover preview shown over an open menu               "the hover preview stands down for an open menu"
 *   `renderCalendar` not hiding the preview                 "a repaint hides the preview"
 *   the view select back to 44px on a fine pointer          "one toolbar height on a desktop"
 *   Checkout offered on completed only                      "the card offers Checkout wherever the server admits it"
 *   slots shaded by business hours only                     "a slot outside the groomer's shift is closed in their column"
 *   a GET 429 thrown at once / a POST retried               "a rate-limited read is asked again, a write never"
 *   the phone toolbar back to three rows                    "the phone toolbar is two rows"
 *   no landscape arm                                        "a phone on its side gets the phone shell"
 *   KPI tiles one per row on a phone                        "the phone dashboard is two by two with the badge shown"
 */
const source = readFileSync("public/app.js", "utf8");
const styles = readFileSync("public/styles.css", "utf8");
const markup = readFileSync("public/index.html", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/** One CSS rule's declarations, by its exact selector, wherever it first sits in the sheet. */
function rule(selector: string): string {
  const index = styles.indexOf(`${selector}{`);
  if (index < 0) throw new Error(`public/styles.css no longer contains ${JSON.stringify(selector)}`);
  return styles.slice(index + selector.length + 1, styles.indexOf("}", index));
}

/** Every media block with exactly this query, as text. */
function media(query: string): string {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const at = styles.indexOf(`@media${query}{`, from);
    if (at < 0) break;
    let depth = 0;
    let index = at + query.length + 7;
    for (; index < styles.length; index += 1) {
      if (styles[index] === "{") depth += 1;
      if (styles[index] === "}") { if (depth === 0) break; depth -= 1; }
    }
    blocks.push(styles.slice(at, index));
    from = index;
  }
  if (!blocks.length) throw new Error(`public/styles.css has no @media${query} block`);
  return blocks.join("\n");
}

function build<T>(body: string, scope: Record<string, unknown>): T {
  const names = Object.keys(scope);
  return (new Function(...names, body) as (...args: unknown[]) => T)(...names.map((name) => scope[name]));
}

const escape = (value = "") =>
  String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

describe("the week grid", () => {
  it("a week slot draws no button border", () => {
    expect(rule(".week-slot")).toMatch(/^height:var\(--slot-height\);border:0;border-left:1px solid var\(--line\)/u);
  });
});

describe("the card strip", () => {
  it("a narrow card keeps the start time and the whole badge", () => {
    // The range is two spans whose text is still the whole range.
    const head = slice("  const [timeFrom,timeTo]=model.timeRangeCompact.split(\"–\");", "\n  const services=");
    expect(head).toContain('<span class="time-from">${escape(timeFrom)}</span>');
    expect(head).toContain('<span class="time-to">–${escape(timeTo)}</span>');
    expect(styles).toContain(".appointment-block .appointment-time{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:clip}");
    expect(styles).toContain(".appointment-block .appointment-badges{flex:none}");
    expect(styles).toContain(".appointment-block .appointment-time>span{display:inline;overflow:visible}");
    // Below 150px the end of the range and the plain notes icon go; the safety alert stays.
    expect(styles).toContain("@container (max-width:150px){.appointment-block .appointment-time .time-to{display:none}.appointment-block .appointment-notes-trigger:not([data-alert]){display:none}}");
    expect(styles).toContain(".appointment-block.density-brief>.calendar-open{min-width:min(50%,44px)}");
  });
});

// ─── Lanes ───────────────────────────────────────────────────────────────────────────────────

const LANES = slice("function columnLanes(entries){", "\n/**\n * The band itself.");
interface Laid { item: { id: string; status?: string }; lane: number; lanes: number; behind?: boolean }
const layout = build<(items: unknown[], day: string, start: number, slots: number, firstRow: number) => Laid[]>(
  `${LANES}\nreturn appointmentColumnLayout;`,
  { appointmentLocalValue: (item: { startAt: string }) => item.startAt.slice(0, 16), blockedTimePlacement: () => null }
);
const visit = (id: string, from: string, to: string, status = "scheduled") =>
  ({ id, status, startAt: `2026-10-27T${from}`, endAt: `2026-10-27T${to}` });

describe("the column layout", () => {
  it("a cancelled visit does not take a lane from a live one", () => {
    const laid = layout([visit("charlie", "12:30", "14:00"), visit("boba", "13:00", "13:20", "cancelled")], "2026-10-27", 480, 20, 2);
    const charlie = laid.find((entry) => entry.item.id === "charlie")!;
    const boba = laid.find((entry) => entry.item.id === "boba")!;
    expect(charlie.lanes).toBe(1);
    expect(boba.lanes).toBe(1);
    expect(boba.behind).toBe(true);
    // Drawn first, so the live card paints over it.
    expect(laid.indexOf(boba)).toBeLessThan(laid.indexOf(charlie));
  });

  it("a no-show beside nothing live is not behind anything, and two live visits still share", () => {
    expect(layout([visit("a", "09:00", "10:00", "no_show")], "2026-10-27", 480, 20, 2)[0]!.behind).toBe(false);
    const both = layout([visit("a", "09:00", "10:00"), visit("b", "09:30", "10:30"), visit("c", "09:00", "10:00", "cancelled")], "2026-10-27", 480, 20, 2);
    expect(both.filter((entry) => entry.item.status === "scheduled").map((entry) => entry.lanes)).toEqual([2, 2]);
  });

  it("the cards carry the flag and the stylesheet draws it behind, at the lane's right", () => {
    expect(source).toContain('${behind?" data-card-behind":""}');
    expect(rule(".week-appointment[data-card-behind]")).toBe("z-index:1");
    expect(rule(".week-appointment[data-card-behind]:not([data-card-lanes])")).toBe("justify-self:end;margin-left:0;margin-right:3px");
  });
});

describe("the now line", () => {
  it("the Now tag sits in the time gutter, at the minute", () => {
    const now = build<(columns: string, row: number, elapsed: number) => string>(`${LANES}\nreturn calendarNowMarkup;`,
      { appointmentLocalValue: () => "", blockedTimePlacement: () => null });
    const html = now("2/-1", 7, 140);
    expect(html).toContain('class="calendar-now-line"');
    expect(html).toContain('style="grid-column:2/-1;grid-row:7;--minute-offset:20"');
    expect(html).toContain('<div class="calendar-now-label" aria-hidden="true" style="grid-column:1;grid-row:7;--minute-offset:20">Now</div>');
    expect(styles).not.toContain('.calendar-now-line::before{content:"Now"');
    expect(rule(".calendar-now-label")).toContain("position:sticky;left:0;z-index:4");
  });
});

// ─── The card menu and the preview ───────────────────────────────────────────────────────────

describe("the card menu", () => {
  it("the card menu is compact rows, with 44px rows where there is no hover", () => {
    expect(styles).toContain(".calendar-action-popover{gap:0;min-width:150px;padding:4px}");
    expect(styles).toContain(".calendar-action{min-height:28px;padding:4px 8px;border:0;");
    expect(styles).toContain(".calendar-action-popover>.calendar-action:not(.terminal-action)+.terminal-action::before{");
    expect(styles).toContain("@media(hover:none){.calendar-action{min-height:44px}}");
  });

  it("the hover preview stands down for an open menu or a detached host", () => {
    const HOVER = slice("function calendarMenuOpen(){", "\nfunction hideCalendarHover(){");
    let menuOpen = true, hidden = 0;
    const show = build<(host: unknown) => void>(`${HOVER}\nreturn showCalendarHover;`, {
      globalThis: { matchMedia: () => ({ matches: true }) },
      document: { querySelector: () => (menuOpen ? {} : null) },
      hideCalendarHover: () => { hidden += 1; },
      blockedTimeById: () => null,
      calendarAppointmentById: () => null
    });
    show({ isConnected: true, dataset: {} });
    expect(hidden).toBe(1);
    menuOpen = false;
    show({ isConnected: false, dataset: {} });
    expect(hidden).toBe(2);
  });

  it("a repaint hides the preview, and opening a menu hides it", () => {
    expect(slice("function renderCalendar(){", "\n// --- The calendar's scroll box")).toMatch(/^function renderCalendar\(\)\{hideCalendarHover\(\);/u);
    expect(slice("find('[data-appointment-menu]').forEach(", "find('.calendar-action-popover').forEach(")).toContain("if(opening){liftCalendarPopover(popover,true);hideCalendarHover();");
  });

  /** The card menu for `item`, seen by a role holding `granted`. */
  function cardMenu(item: Record<string, unknown>, granted: readonly string[]): string {
    const MENU = slice("function calendarScopeAttrs(item){", "\n// The hash fallback.");
    const set = new Set(granted);
    return build<(item: unknown) => string>(`${MENU}\nreturn calendarAction;`, {
      escape, petName: (record: { petName?: string }) => record.petName || "Pet",
      allowed: (key: string) => set.has(key), scopeAllows: () => true, appointmentScopeRefusal: () => "",
      appointmentMoveAllowed: () => set.has("appointments.edit"), appointmentLockNoteMarkup: () => "",
      appointmentInvoiceOutstanding: (row: { invoiceBalanceMinor?: number }) => Number(row.invoiceBalanceMinor || 0) > 0
    })({ id: "a1", petName: "Rex", ...item });
  }

  it("the card offers Checkout wherever the server admits it", () => {
    for (const status of appointmentStatuses) {
      const html = cardMenu({ status }, ["checkout.perform", "operations.perform_service"]);
      const offered = html.includes('data-testid="appointment-checkout"') || html.includes('data-testid="appointment-completed"');
      expect(offered, status).toBe(canEnterCheckout(status));
    }
    // Money is permission-gated, and a settled bill is not offered again.
    expect(cardMenu({ status: "checked_in" }, [])).not.toContain("appointment-checkout");
    expect(cardMenu({ status: "checked_in", invoiceId: "i1", invoiceBalanceMinor: 0 }, ["checkout.perform"])).not.toContain("appointment-checkout");
    expect(cardMenu({ status: "checked_in", invoiceId: "i1", invoiceBalanceMinor: 500 }, ["checkout.perform"])).toContain("appointment-checkout");
    // It follows the transition when there is one, and leads when there is not.
    expect(cardMenu({ status: "checked_in" }, ["checkout.perform", "operations.perform_service"]).indexOf("Start service"))
      .toBeLessThan(cardMenu({ status: "checked_in" }, ["checkout.perform", "operations.perform_service"]).indexOf(">Checkout<"));
    expect(cardMenu({ status: "checked_in" }, ["checkout.perform"]).indexOf(">Checkout<"))
      .toBeLessThan(cardMenu({ status: "checked_in" }, ["checkout.perform"]).indexOf("View / Edit"));
    expect(source).toContain('$$(".checkout-action").forEach(button=>button.addEventListener("click",()=>runDetached(()=>runOnce(`checkout:${button.dataset.id}`,()=>checkout(button.dataset.id)))));');
  });
});

// ─── Toolbar ─────────────────────────────────────────────────────────────────────────────────

describe("the toolbar", () => {
  it("one toolbar height on a desktop; the select keeps its 44px box on a coarse pointer", () => {
    expect(styles).toContain(".calendar-view-select select{min-height:var(--control-h);");
    expect(styles).toContain("@media(pointer:coarse){#calendar-view-select{min-height:44px}}");
    expect(styles).not.toMatch(/\[data-testid="nav-customers"\],#calendar-view-select,/u);
    expect(rule(".calendar-toolbar .compact")).toBe("min-height:var(--control-h)");
  });

  it("the phone toolbar is two rows", () => {
    expect(media("(max-width:580px)")).toContain('grid-template-areas:"today nav nav view view" "mode mode filter print gear"');
    expect(markup).toContain('<summary id="groomer-filter-trigger" aria-label="Filter calendar by groomer" aria-expanded="false"><span class="groomer-filter-label">All groomers </span>');
  });
});

// ─── Off-hours per groomer ───────────────────────────────────────────────────────────────────

describe("the groomer's own hours", () => {
  const SLOTS = slice("function calendarSlotAttributes(open,preset,groomerId){", "\n/**\n * WHY, in a sentence");
  const GRACE = { id: "grace", days: [{ weekday: 2, startTime: "08:00", endTime: "16:00" }] };
  const load = (staffHours: unknown) => build<{
    attrs: (open: boolean, preset: string, groomerId: string) => { closed: boolean; label: string; hooks: string };
    fit: (groomerId: string, day: string, from: number, to: number) => boolean;
  }>(`${SLOTS}\nreturn { attrs: calendarSlotAttributes, fit: staffHoursFit };`, {
    state: { staffHours }, calendarSlotActionable: () => true, api: async () => ({}),
    dateAt: (value: string) => new Date(`${value}T12:00:00Z`)
  });

  it("a slot outside the groomer's shift is closed in their column", () => {
    const { attrs } = load([GRACE]);
    // 2026-10-27 is a Tuesday.
    expect(attrs(true, "2026-10-27T15:30", "grace")).toEqual({ closed: false, label: ", create appointment", hooks: 'data-slot="2026-10-27T15:30" data-slot-groomer="grace"' });
    expect(attrs(true, "2026-10-27T16:00", "grace")).toEqual({ closed: true, label: ", outside working hours", hooks: "disabled" });
    expect(attrs(false, "2026-10-27T19:00", "grace").label).toBe(", closed");
  });

  it("an unconfigured groomer, an unknown one, or a failed read restricts nothing", () => {
    expect(load([{ id: "sam", days: [] }]).attrs(true, "2026-10-27T20:00", "sam").closed).toBe(false);
    expect(load([GRACE]).attrs(true, "2026-10-27T20:00", "someone").closed).toBe(false);
    expect(load(null).attrs(true, "2026-10-27T20:00", "grace").closed).toBe(false);
  });

  it("a drop is judged by its whole length", () => {
    const { fit } = load([GRACE]);
    expect(fit("grace", "2026-10-27", 14 * 60, 15 * 60 + 30)).toBe(true);
    expect(fit("grace", "2026-10-27", 15 * 60, 16 * 60 + 30)).toBe(false);
    expect(source).toContain('const outside=drag.kind==="appointment"&&!staffHoursFit(slot.dataset.slotGroomer,');
    expect(rule(".calendar-drop-preview[data-outside-hours]")).toContain("border-color:var(--danger)");
  });
});

// ─── 429 on a read ───────────────────────────────────────────────────────────────────────────

describe("the shared fetch helper", () => {
  const API = slice("const API_READ_TRIES=", "\n/**\n * A REFUSAL THE SERVER WILL WITHDRAW");
  function harness(statuses: number[], retryAfter = "1") {
    const calls: string[] = [];
    const waits: number[] = [];
    const responses = [...statuses];
    const fetch = async (_path: string, options: { method?: string }) => {
      calls.push(options.method || "GET");
      const status = responses.shift() ?? 200;
      return {
        status, ok: status < 400,
        headers: { get: (name: string) => (name === "retry-after" ? retryAfter : null) },
        json: async () => (status < 400 ? { ok: true } : { error: "Rate limit exceeded" })
      };
    };
    const api = build<(path: string, options?: Record<string, unknown>) => Promise<unknown>>(`${API}\nreturn api;`, {
      fetch, unloading: false, isAbortedRequest: () => false, settleUnauthenticated: () => {}, reconcilePermissions: async () => {},
      userFacingErrorMessage: (message: string) => message,
      retryAfterSeconds: (response: { headers: { get(name: string): string | null } }) => Number(response.headers.get("retry-after")) || 5,
      globalThis: { setTimeout: (resolve: () => void, ms: number) => { waits.push(ms); resolve(); } }
    });
    return { api, calls, waits };
  }

  it("a rate-limited read is asked again after Retry-After", async () => {
    const { api, calls, waits } = harness([429, 429]);
    await expect(api("/api/appointments")).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["GET", "GET", "GET"]);
    expect(waits).toEqual([1000, 1000]);
  });

  it("three tries in all, then the 429 reaches the caller", async () => {
    const { api, calls } = harness([429, 429, 429, 429]);
    await expect(api("/api/appointments")).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(3);
  });

  it("a write is never retried, nor a wait too long to sit through", async () => {
    const write = harness([429]);
    await expect(write.api("/api/appointments", { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 429 });
    expect(write.calls).toEqual(["POST"]);
    const long = harness([429], "45");
    await expect(long.api("/api/appointments")).rejects.toMatchObject({ status: 429 });
    expect(long.calls).toHaveLength(1);
  });

  it("a calendar read that still fails draws the requested view with an inline Retry", () => {
    const load = slice("async function loadCalendarWeek(", "\nasync function openCalendarView(){");
    expect(load).toContain("state.calendar.readError=error;");
    expect(load).toContain("applyCalendarPeriod({appointments:[],blockedTimes:[]},null);");
    expect(load).toContain("if(!navigating)throw error;");
    expect(slice("function renderCalendarReadError(){", "\n/**")).toContain('data-testid="calendar-read-retry"');
    expect(slice("async function openCalendarView(){", "\n/**")).toContain("!state.calendar.readError&&!state.appointments.length");
  });
});

// ─── The shell ───────────────────────────────────────────────────────────────────────────────

describe("the shell", () => {
  it("a phone on its side gets the phone shell", () => {
    const land = media("(max-width:900px) and (max-height:500px) and (orientation:landscape)");
    expect(land).toContain(".mobile-nav-toggle{display:block;");
    expect(land).toContain(".primary-nav{display:none}");
    expect(land).toContain("#modal .modal-actions{position:sticky;bottom:0;");
    expect(land).toContain(".week-scroll{height:max(160px,");
  });

  it("the phone dashboard is two by two with the badge shown", () => {
    const phone = media("(max-width:580px)");
    expect(phone).toContain(".metric-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}");
    expect(phone).toContain(".appointment{grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:8px 10px}");
    expect(phone).toContain(".appointment .badge{display:inline-block;white-space:nowrap}");
  });
});

// ─── Review W-2 / W-3 · a failed re-read keeps the grid; a navigating read says it is loading ─

describe("the calendar loader", () => {
  const LOADER = slice("let calendarReadSerial=0;", "\nasync function openCalendarView(){");
  function harness() {
    const state = {
      appointments: [{ id: "painted" }] as unknown[], blockedTimes: [] as unknown[], todayAppointments: [] as unknown[], businessHours: [{ weekday: 1 }],
      calendar: { view: "week", displayMode: "calendar", weekStart: "2026-10-25", selectedDate: "2026-10-27", month: "2026-10",
        monthAppointments: [{ id: "m" }] as unknown[], selectedGroomerIds: null, paintedKey: null as string | null, readError: null as unknown }
    };
    let fail = false;
    let gate: Promise<void> | null = null;
    let renders = 0;
    const busy: boolean[] = [];
    const label = { textContent: "Oct 25 – Oct 31, 2026", loading: false,
      classList: { toggle: (_name: string, on: boolean) => { label.loading = on; } } };
    const attrs: Record<string, string> = {};
    const list = { getAttribute: (name: string) => attrs[name] ?? null, setAttribute: (name: string, value: string) => { attrs[name] = value; } };
    const scroll = { classList: { toggle: (_name: string, on: boolean) => { busy.push(on); } } };
    const load = build<(start?: string) => Promise<void>>(`${LOADER}\nreturn loadCalendarWeek;`, {
      state, document: { body: { dataset: { view: "calendar" } } }, businessDate: () => "2026-10-02",
      calendarDisplayRange: () => ({ start: state.calendar.weekStart, days: 7, blocks: true }),
      calendarRangeQueries: (start: string, days: number) => [`localDate=${start}&days=${days}`],
      readCalendarPeriod: async () => {
        const wait = gate; gate = null;
        if (wait) await wait;
        if (fail) throw Object.assign(new Error("fault"), { status: 500 });
        return { appointments: [{ id: "fresh" }], blockedTimes: [] };
      },
      api: async () => [], loadAppointmentRange: async () => [], loadStaffHours: async () => null,
      loadCalendarMonth: async () => [], appointmentLocalValue: () => "2026-10-02T09:00",
      renderAppointments: () => { renders += 1; }, renderCalendarReadError: () => {},
      $: (selector: string) => (selector === "#calendar-list" ? list : selector === "#calendar-range" ? label
        : selector === "#calendar .week-scroll" ? scroll : null)
    });
    return { state, load, busy, label, attrs, renders: () => renders, setFail: (value: boolean) => { fail = value; },
      hold: () => { let open!: () => void; gate = new Promise<void>((resolve) => { open = resolve; }); return () => open(); } };
  }

  it("a failed re-read of the painted period keeps the grid and throws to its caller", async () => {
    const app = harness();
    await app.load();
    expect(app.state.appointments).toEqual([{ id: "fresh" }]);
    app.setFail(true);
    await expect(app.load()).rejects.toThrow("fault");
    expect(app.state.appointments).toEqual([{ id: "fresh" }]);
    expect(app.state.calendar.readError).toBeNull();
  });

  it("a failed navigation draws the new period empty with the banner, and stays a navigation", async () => {
    const app = harness();
    await app.load();
    app.setFail(true);
    await app.load("2026-11-01");
    expect(app.state.appointments).toEqual([]);
    expect(app.state.calendar.readError).toBeTruthy();
    expect(app.state.calendar.paintedKey).toBeNull();
  });

  it("a navigating read marks the grid busy until it lands; a re-read does not", async () => {
    const app = harness();
    const pending = app.load();
    expect(app.attrs["aria-busy"]).toBe("true");
    // The label's text is the paint's to change (waits on it are waits for the paint); busy is a class.
    expect(app.label.textContent).toBe("Oct 25 – Oct 31, 2026");
    expect(app.label.loading).toBe(true);
    expect(styles).toContain(".week-scroll.calendar-loading>#calendar-list{opacity:.5;transition:opacity .15s;pointer-events:none}");
    await pending;
    expect(app.attrs["aria-busy"]).toBe("false");
    expect(app.label.loading).toBe(false);
    expect(app.busy).toEqual([true, false]);
    await app.load();
    expect(app.busy.filter(Boolean)).toHaveLength(1);
    expect(app.attrs["aria-busy"]).toBe("false");
    app.setFail(true);
    await app.load("2026-11-01");
    expect(app.busy.filter(Boolean)).toHaveLength(2);
    expect(app.attrs["aria-busy"]).toBe("false");
  });

  it("a there-and-back before the navigation lands leaves nothing busy - the re-read that supersedes it clears it", async () => {
    const app = harness();
    await app.load();
    const release = app.hold();
    const forward = app.load("2026-11-01");
    expect(app.attrs["aria-busy"]).toBe("true");
    await app.load("2026-10-25");
    release();
    await forward;
    expect(app.attrs["aria-busy"]).toBe("false");
  });

  it("a failed re-read that supersedes a navigation clears the busy state and redraws the painted grid", async () => {
    const app = harness();
    await app.load();
    const release = app.hold();
    const forward = app.load("2026-11-01");
    const rendersBefore = app.renders();
    app.setFail(true);
    await expect(app.load("2026-10-25")).rejects.toThrow("fault");
    expect(app.attrs["aria-busy"]).toBe("false");
    expect(app.renders()).toBe(rendersBefore + 1);
    expect(app.state.appointments).toEqual([{ id: "fresh" }]);
    release();
    await forward.catch(() => {});
  });
});
