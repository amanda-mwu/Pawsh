import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QA ROUND 3 · THE CALENDAR AS A GROOMER AND THE DESK USE IT.
 *
 * Human QA found five things wrong with the grid and one with signing in:
 *
 *   1. only the body under a card's strip opened the visit, so a short, brief or cancelled card -
 *      which is nothing but its strip - could only be reached through the "⋯";
 *   3. a lone visit stopped 16px short of its lane for a cancelled visit that was not there;
 *   4. once Daisy was invoiced her chip said "UNP" and nothing said she was ready to go home;
 *   5. a groomer signing in after somebody else inherited their scroll and no reveal, so today
 *      was off-screen;
 *   6. a groomer could not move her own lunch from a phone: a band was a fine-pointer drag only.
 *
 * (2, the strip itself, is CSS; tests/ui/qa-pass-calendar.test.ts holds the rules and
 * tests/e2e/qa-pass-calendar.spec.ts measures them.)
 *
 * Every function here runs as written - sliced out of `public/app.js` - against the smallest fakes
 * it needs.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ───────────────────────────────────────────────────────────
 *
 *   the card-wide click handler removed, or opening from inside a control   "the whole card opens the visit"
 *   the reserve back on a lone card (`covers` always true / never computed)  "a lone visit takes its lane"
 *   RDY dropped once an invoice exists, or kept once it is paid              "an unsettled completed visit reads Ready for pickup"
 *   `resetCalendarReveal` not clearing the key or the scroll                 "a new session reveals its own today"
 *   the fine-pointer gate back on a band, or the scope gate gone             "a groomer may drag her own band, on any pointer"
 *   a touch lifting the band before the hold, or a swipe lifting it at all   "a finger lifts a band by holding it"
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

function build<T>(body: string, scope: Record<string, unknown>): T {
  const names = Object.keys(scope);
  return (new Function(...names, body) as (...args: unknown[]) => T)(...names.map((name) => scope[name]));
}

const escape = (value: unknown = "") =>
  String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();

type Listener = (event: Record<string, unknown>) => void;
/** A document that only records what is added to it, so a handler can be called as the browser would. */
function fakeDocument() {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    body: { classList: { add() {}, remove() {} }, dataset: { view: "calendar" } },
    addEventListener(type: string, listener: Listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    fire(type: string, event: Record<string, unknown>) { for (const listener of listeners.get(type) ?? []) listener(event); }
  };
}

// ─── 1 · the whole card opens the visit ──────────────────────────────────────────────────────

describe("the whole card opens the visit", () => {
  const CLICK = slice(
    "document.addEventListener(\"click\",event=>{\n  const card=event.target.closest?.(\".appointment-block[data-appointment-id]\");",
    "\n/* == The Block Time dialog"
  );

  function harness() {
    const document = fakeDocument(), opened: Array<[string, unknown]> = [];
    let closed = 0;
    build(CLICK, {
      document,
      closeCalendarMenus: () => { closed += 1; },
      openCalendarAppointment: (id: string, origin: unknown) => { opened.push([id, origin]); }
    });
    return { click: (event: Record<string, unknown>) => document.fire("click", event), opened, closed: () => closed };
  }

  /** A node inside a card: `inside` names the selectors it sits within (the card itself is implied). */
  function target(inside: string[] = []) {
    const openButton = { id: "body-button" };
    const card = { dataset: { appointmentId: "visit-1" }, querySelector: (selector: string) => (selector === ".calendar-open" ? openButton : null) };
    return {
      openButton,
      node: {
        closest: (selector: string) => {
          if (selector === ".appointment-block[data-appointment-id]") return card;
          return selector.split(",").some((part) => inside.includes(part)) ? {} : null;
        }
      }
    };
  }

  it("a press on the strip - the time, the chip, a brief card's only line - opens the visit", () => {
    const app = harness(), { node, openButton } = target();
    app.click({ target: node, defaultPrevented: false });
    expect(app.opened).toEqual([["visit-1", openButton]]);
    expect(app.closed()).toBe(1);
  });

  it("the card's own controls keep their own job: the notes button and the menu open nothing here", () => {
    const app = harness();
    app.click({ target: target(["button"]).node, defaultPrevented: false });
    app.click({ target: target(["[role=menuitem]"]).node, defaultPrevented: false });
    app.click({ target: target([".calendar-action-popover"]).node, defaultPrevented: false });
    expect(app.opened).toEqual([]);
  });

  it("a click a completed drag already swallowed opens nothing, and a press outside any card is not its business", () => {
    const app = harness();
    app.click({ target: target().node, defaultPrevented: true });
    app.click({ target: { closest: () => null }, defaultPrevented: false });
    expect(app.opened).toEqual([]);
  });
});

// ─── 3 · a lone visit takes its lane ─────────────────────────────────────────────────────────

describe("a lone visit takes its lane", () => {
  const LANES = slice("function columnLanes(entries){", "\n/**\n * The band itself.");
  interface Item { id: string; status: string; startAt: string; endAt: string }
  interface Laid { item: Item; lanes: number; behind?: boolean; covers?: boolean }
  const layout = build<(items: Item[], day: string, start: number, slots: number, firstRow: number) => Laid[]>(
    `${LANES}\nreturn appointmentColumnLayout;`,
    { appointmentLocalValue: (item: Item) => item.startAt.slice(0, 16), blockedTimePlacement: () => { throw new Error("not exercised"); } }
  );
  const visit = (id: string, from: string, to: string, status = "scheduled"): Item =>
    ({ id, status, startAt: `2026-10-07T${from}`, endAt: `2026-10-07T${to}` });
  const shape = (laid: Laid[]) => laid.map((entry) => [entry.item.id, entry.lanes, Boolean(entry.behind), Boolean(entry.covers)]);

  it("a visit with nothing else in its column covers nothing, so it is drawn the whole lane wide", () => {
    expect(shape(layout([visit("rocky", "10:00", "10:45")], "2026-10-07", 480, 20, 2))).toEqual([["rocky", 1, false, false]]);
  });

  it("a cancelled visit elsewhere in the day does not narrow it either", () => {
    const laid = layout([visit("rocky", "10:00", "10:45"), visit("luna", "15:30", "15:45", "cancelled")], "2026-10-07", 480, 20, 2);
    expect(shape(laid)).toEqual([["luna", 1, false, false], ["rocky", 1, false, false]]);
  });

  it("only a live visit with a cancelled one behind it keeps the reserve the sliver shows through", () => {
    const laid = layout([visit("rocky", "10:00", "11:00"), visit("luna", "10:30", "11:00", "no_show")], "2026-10-07", 480, 20, 2);
    expect(shape(laid)).toEqual([["luna", 1, true, false], ["rocky", 1, false, true]]);
  });
});

// ─── 4 · ready for pickup reads on every surface ─────────────────────────────────────────────

describe("an unsettled completed visit reads Ready for pickup", () => {
  const BADGES = slice("const APPOINTMENT_BADGES=", "\n/**\n * THE PET'S CARE RECORD");
  const ROW = slice("function appointmentHtml(item) {", "\nfunction renderAppointments()");
  interface Badge { code: string; label: string; variant: string }
  const app = build<{
    appointmentBadges(item: Record<string, unknown>): Badge[];
    appointmentLifecycleLabel(item: Record<string, unknown>): string;
    appointmentHtml(item: Record<string, unknown>): string;
  }>(`${BADGES}\n${ROW}\nreturn { appointmentBadges, appointmentLifecycleLabel, appointmentHtml };`, {
    escape,
    schedulingTime: () => "1:00 PM",
    clientName: (item: { customerName: string }) => item.customerName,
    petName: (item: { petName: string }) => item.petName,
    safetyContext: () => "",
    calendarAction: () => "<!--menu-->"
  });
  const codes = (item: Record<string, unknown>) => app.appointmentBadges(item).map((badge) => badge.code);
  const daisy = (extra: Record<string, unknown> = {}) =>
    ({ id: "daisy", status: "completed", petName: "Daisy", customerName: "Avery Thompson", employeeName: "Grace Groomer", ...extra });

  it("completed with an open invoice wears RDY and the unpaid marker beside it, in that order", () => {
    expect(codes(daisy({ invoiceStatus: "open" }))).toEqual(["RDY", "UNP"]);
    expect(codes(daisy({ invoiceStatus: "partially_paid" }))).toEqual(["RDY", "UNP"]);
    expect(app.appointmentBadges(daisy({ invoiceStatus: "open" }))[0]).toEqual({ code: "RDY", label: "Ready for pickup", variant: "ready" });
  });

  it("completed and not yet invoiced is ready for pickup alone", () => {
    expect(codes(daisy())).toEqual(["RDY"]);
  });

  it("a settled visit has gone home: its payment chip is the whole story", () => {
    expect(codes(daisy({ invoiceStatus: "paid" }))).toEqual(["PAI"]);
    expect(codes(daisy({ invoiceStatus: "refunded" }))).toEqual(["REF"]);
    expect(codes(daisy({ invoiceStatus: "partially_refunded" }))).toEqual(["PRF"]);
  });

  it("an open bill on a visit still in progress keeps its lifecycle too", () => {
    expect(codes({ status: "checked_in", invoiceStatus: "open" })).toEqual(["CHK", "UNP"]);
    expect(codes({ status: "scheduled" })).toEqual(["SCH"]);
  });

  it("the surfaces' label says Ready for pickup exactly where the chip says RDY", () => {
    expect(app.appointmentLifecycleLabel(daisy({ invoiceStatus: "open" }))).toBe("Ready for pickup");
    expect(app.appointmentLifecycleLabel(daisy())).toBe("Ready for pickup");
    expect(app.appointmentLifecycleLabel(daisy({ invoiceStatus: "paid" }))).toBe("Completed");
    expect(app.appointmentLifecycleLabel({ status: "in_service" })).toBe("In service");
  });

  it("the dashboard row says Ready for pickup and carries the card's unpaid chip", () => {
    const row = app.appointmentHtml(daisy({ invoiceStatus: "open" }));
    expect(text(row)).toContain("Ready for pickup UNP");
    expect(row).toContain('<span class="appointment-badge badge-unpaid" role="img" aria-label="Unpaid">UNP</span>');
    expect(text(app.appointmentHtml(daisy({ invoiceStatus: "paid" })))).toContain("Completed PAI");
    expect(app.appointmentHtml({ ...daisy(), status: "scheduled" })).not.toContain("appointment-badge");
  });
});

describe("the card and the hover wear both chips", () => {
  const PRESENTATION = slice("const ADD_ON_SERVICE_CATEGORIES=", "\n/**\n * THE CARD'S OVERFLOW MENU");
  const CARD = slice("function appointmentCard(item,", "\n// == Blocked time on the grid");
  const clock = (value: Date) => value.toISOString().slice(11, 16);
  const app = build<{
    appointmentCard(item: Record<string, unknown>): string;
    appointmentHoverDetails(model: unknown, badges: unknown): string;
    appointmentPresentation(item: Record<string, unknown>): unknown;
    appointmentBadges(item: Record<string, unknown>): unknown;
  }>(`${PRESENTATION}\n${CARD}\nreturn { appointmentCard, appointmentHoverDetails, appointmentPresentation, appointmentBadges };`, {
    state: { services: [], employees: [] }, escape,
    petName: (record: { petName?: string }) => record.petName, clientName: (record: { customerName?: string }) => record.customerName,
    formatPrefTime: clock, formatPrefWeekdayLongMonthDay: () => "Tuesday, October 6", formatPrefDateAndTime: () => "",
    compactTimeRange: (start: Date, end: Date) => `${clock(start)}–${clock(end)}`,
    appointmentLocalValue: (item: { startAt: string }) => item.startAt.slice(0, 16), schedulingZone: () => "UTC",
    money: () => "", calendarDragAvailable: () => false, scopeAllows: () => true, groomerColorSlot: () => 0,
    safetyContext: () => "", calendarAction: () => ""
  });
  const daisy = {
    id: "daisy", status: "completed", invoiceStatus: "open", startAt: "2026-10-06T13:00:00.000Z", endAt: "2026-10-06T14:40:00.000Z",
    petName: "Daisy", breed: "Cocker Spaniel", customerName: "Avery Thompson", groomers: [{ displayName: "Grace Groomer" }], services: []
  };

  it("the card's strip carries RDY then UNP, each with its own accessible name", () => {
    const card = app.appointmentCard(daisy);
    expect(card).toMatch(/aria-label="Ready for pickup">.*<span class="badge-code">RDY<\/span>.*aria-label="Unpaid">.*<span class="badge-code">UNP<\/span>/u);
  });

  it("the hover spells both out", () => {
    const hover = app.appointmentHoverDetails(app.appointmentPresentation(daisy), app.appointmentBadges(daisy));
    expect(text(hover)).toMatch(/^Status: RDY Ready for pickup · UNP Unpaid /u);
  });
});

// ─── 5 · a new session reveals its own today ─────────────────────────────────────────────────

describe("a new session reveals its own today", () => {
  const REVEAL = slice("let calendarRevealKey=null;", "\n// WHERE EACH VIEW OPENS.");

  it("signing out forgets the revealed period and the scroll, so the next sign-in reveals again", () => {
    const scroll = { clientWidth: 1155, scrollLeft: 1149, scrollTop: 90 };
    const state = { calendar: { displayMode: "calendar", view: "week", selectedDate: "2026-10-06", weekStart: "2026-10-04", month: "2026-10" } };
    const app = build<{ calendarRevealDue(): boolean; resetCalendarReveal(): void }>(
      `${REVEAL}\nreturn { calendarRevealDue, resetCalendarReveal };`,
      { $: (selector: string) => (selector === ".week-scroll" ? scroll : null), document: { body: { dataset: { view: "calendar" } } }, state }
    );
    // The owner's session revealed this week, then scrolled away from today.
    expect(app.calendarRevealDue()).toBe(true);
    expect(app.calendarRevealDue()).toBe(false);
    // Signing out (resetTenantState) and Grace signing in to the same week.
    app.resetCalendarReveal();
    expect(scroll).toMatchObject({ scrollLeft: 0, scrollTop: 0 });
    expect(app.calendarRevealDue()).toBe(true);
  });

  it("the session reset is what calls it", () => {
    const reset = slice("function resetTenantState() {", "\nlet customerSearchSequence");
    let called = 0;
    build(`${reset}\nresetTenantState();`, {
      stopTerminalCapturePoll: () => {}, state: { login: false }, emptyState: () => ({}), tenantCaches: [],
      resetBusinessWorkspace: () => {}, petCoatColors: [], dismissedAgreementBanners: new Set(),
      resetCalendarReveal: () => { called += 1; }
    });
    expect(called).toBe(1);
  });
});

// ─── 6 · a groomer moves her own band, by mouse or by finger ─────────────────────────────────

describe("a groomer may drag her own band, on any pointer", () => {
  const GATE = slice("function blockedTimeScopeAllows(block){", "\n/** `blockedTimePlusHour`");
  function gate({ keys, me }: { keys: string[]; me: string | null }) {
    return build<(block: { employeeId: string }) => boolean>(`${GATE}\nreturn blockedTimeDragAvailable;`, {
      allowed: (key: string) => keys.includes(key),
      myEmployeeId: () => me,
      blockedTimeSpan: () => ({ editable: true }),
      // A phone: no hover, a coarse pointer. Nothing in the gate may ask.
      globalThis: { matchMedia: () => ({ matches: false }) }
    });
  }
  const groomer = ["calendar.blocks_edit"];

  it("her own lunch is draggable on a phone as on a desk", () => {
    expect(gate({ keys: groomer, me: "grace" })({ employeeId: "grace" })).toBe(true);
  });

  it("a colleague's block stays where it is, and a role without the edit key moves nothing", () => {
    expect(gate({ keys: groomer, me: "grace" })({ employeeId: "gabriel" })).toBe(false);
    expect(gate({ keys: [], me: "grace" })({ employeeId: "grace" })).toBe(false);
    expect(gate({ keys: [...groomer, "appointments.edit_all_staff"], me: "owner" })({ employeeId: "gabriel" })).toBe(true);
  });
});

describe("a finger lifts a band by holding it", () => {
  const DRAG = slice("function endCalendarDrag(commit){", "\nfunction dropSlotLabel(");
  const CONSTANTS = slice("const CALENDAR_DRAG_THRESHOLD=", "\nlet calendarDrag=null;");

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function harness() {
    const document = fakeDocument(), began: string[] = [];
    const band = { dataset: { blockedTimeId: "lunch" }, hasPointerCapture: () => false, classList: { remove() {} }, style: { removeProperty() {} } };
    const api = build<{ current(): { active: boolean } | null }>(
      `${CONSTANTS}\nlet calendarDrag=null;\n${DRAG}\nreturn { current: () => calendarDrag };`,
      {
        document, globalThis,
        calendarDragCard: (target: { band?: boolean }) => (target.band ? band : null),
        blockedTimeById: () => ({ id: "lunch", scheduledLocalStart: "2026-10-06T12:00", scheduledLocalEnd: "2026-10-06T12:30", employeeId: "grace" }),
        blockedTimeDragAvailable: () => true, blockedTimeMinutes: (wall: string) => Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16)),
        calendarDragAvailable: () => false, calendarAppointmentById: () => null, scopeAllows: () => false, appointmentLocalValue: () => "",
        beginCalendarDrag: () => { began.push("begin"); },
        positionDraggedCard: () => {}, highlightDropSlot: () => {}, calendarDropSlot: () => null, swallowNextClick: () => {}
      }
    );
    const pointer = (type: string, x: number, y: number, pointerType = "touch") =>
      document.fire(type, { pointerType, pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y, target: { band: true } });
    return { pointer, began, current: api.current, document };
  }

  it("a still finger held for the hold lifts the band; before the hold it has not", () => {
    const app = harness();
    app.pointer("pointerdown", 100, 200);
    vi.advanceTimersByTime(300);
    expect(app.began).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(app.began).toEqual(["begin"]);
  });

  it("a finger that travels before the hold is scrolling: no lift, then or later", () => {
    const app = harness();
    app.pointer("pointerdown", 100, 200);
    app.pointer("pointermove", 100, 240);
    vi.advanceTimersByTime(1000);
    expect(app.began).toEqual([]);
    expect(app.current()).toBeNull();
  });

  it("a tap lets go before the hold, so the click that follows still opens the block", () => {
    const app = harness();
    app.pointer("pointerdown", 100, 200);
    app.pointer("pointerup", 100, 200);
    vi.advanceTimersByTime(1000);
    expect(app.began).toEqual([]);
  });

  it("a mouse still drags on travel, with no hold", () => {
    const app = harness();
    app.pointer("pointerdown", 100, 200, "mouse");
    app.pointer("pointermove", 100, 220, "mouse");
    expect(app.began).toEqual(["begin"]);
  });

  it("once the band is lifted, the finger's move does not scroll the grid underneath it", () => {
    const app = harness();
    app.pointer("pointerdown", 100, 200);
    vi.advanceTimersByTime(400);
    const current = app.current() as { active: boolean };
    current.active = true; // what the real beginCalendarDrag sets
    let prevented = false;
    app.document.fire("touchmove", { cancelable: true, preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
  });
});
