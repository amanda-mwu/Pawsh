import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE P1 ROWS OF THE UI CONVERGENCE AUDIT, PINNED.
 *
 * Each block below holds one fix in place by running the client's own code - sliced out of
 * `public/app.js` rather than restated - against the smallest fake it needs, or by reading the
 * one rule in `public/styles.css` the fix lives in. What a browser has to be asked (the grid
 * filling a viewport, a menu's rows under a finger) is held by `tests/e2e/ui-convergence.spec.ts`.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `.week-scroll` back to `max-height:70vh`                    "the scroll box is sized to the viewport"
 *   `liftCalendarPopover` no longer calling `showPopover`        "the card menu is lifted into the top layer"
 *   `placeCalendarPopover` never flipping above the trigger      "a menu with no room below opens above"
 *   `transientRefusal` treating a 429 as a verdict               "a rate limit is not a sign-out"
 *   `resumeSession` catching with `bootstrap()` alone            "a busy /api/me on resume retries"
 *   `nav-customers` gated on `pets.view` again                   "the Clients item is gated on what the route needs"
 *   `showView`'s catch calling `bootstrap()`                     "a refused view load is spoken, not swallowed"
 *   `.checkout-settled{padding:0}` restored                      "the settled statement keeps the column's padding"
 *   the note back in `invoiceDocumentActionsMarkup`              "the invoice footer holds the balance and the actions only"
 *   `.booking-client{display:block}` dropped                     "the booking rail is one column on a phone"
 *   `DAY_LANE_WIDTH_PHONE` drifting from the stylesheet          "the phone day lane floor is one number"
 *   `calendarAppointmentById` reading the two grid caches only   "a today row is found once the calendar has paged away"
 *   `applyCalendarAppointment` skipping the today list           "a row the server hands back replaces the today list's copy"
 *   `transientRefusal` taking any 5xx as transient               "a 5xx is transient on /api/me and nowhere else"
 *   `retrySessionLater` without its ceiling                      "the sixth refusal in a row is the last"
 *   `clearSessionRetry` dropped from sign-in or sign-out         "a pending retry is dropped on sign-in and sign-out"
 *   `loadClientNotes` sending the request regardless             "a role without customers.view never asks for the notes"
 *   `petCareNotes` flagging every kind as an alarm                "only the safety alert is an alarm"
 *   `warning` folding the five notes together again               "the model's warning is the alarm alone"
 *   the badge back to `badge.code` alone                           "a card badge carries the word and the code"
 *   `.appointment-time` elastic again                              "the time never gives way in the strip"
 *   `calendarDragScrollLimit` reading `scrollHeight`               "edge auto-scroll stops at the grid's last row"
 *   `moveQuestion` naming no pet                                   "the move question names the pet and both times"
 *   `revealCalendarAppointment` never scrolling                    "a booked or moved card is scrolled into the box"
 *   the kicker back in the modal head                               "the shared dialog carries no generic kicker"
 *   Save before Cancel in a note editor                             "inline note editors order Cancel then Save"
 *   `durationLabel` writing hours again                            "one way to write a length of time"
 *   a focus rule back on the danger colour                          "every focus ring is the brand ring"
 *   `Balance import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE P1 ROWS OF THE UI CONVERGENCE AUDIT, PINNED.
 *
 * Each block below holds one fix in place by running the client's own code - sliced out of
 * `public/app.js` rather than restated - against the smallest fake it needs, or by reading the
 * one rule in `public/styles.css` the fix lives in. What a browser has to be asked (the grid
 * filling a viewport, a menu's rows under a finger) is held by `tests/e2e/ui-convergence.spec.ts`.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `.week-scroll` back to `max-height:70vh`                    "the scroll box is sized to the viewport"
 *   `liftCalendarPopover` no longer calling `showPopover`        "the card menu is lifted into the top layer"
 *   `placeCalendarPopover` never flipping above the trigger      "a menu with no room below opens above"
 *   `transientRefusal` treating a 429 as a verdict               "a rate limit is not a sign-out"
 *   `resumeSession` catching with `bootstrap()` alone            "a busy /api/me on resume retries"
 *   `nav-customers` gated on `pets.view` again                   "the Clients item is gated on what the route needs"
 *   `showView`'s catch calling `bootstrap()`                     "a refused view load is spoken, not swallowed"
 *   `.checkout-settled{padding:0}` restored                      "the settled statement keeps the column's padding"
 *   the note back in `invoiceDocumentActionsMarkup`              "the invoice footer holds the balance and the actions only"
 *   `.booking-client{display:block}` dropped                     "the booking rail is one column on a phone"
 *   `DAY_LANE_WIDTH_PHONE` drifting from the stylesheet          "the phone day lane floor is one number"
 *   `calendarAppointmentById` reading the two grid caches only   "a today row is found once the calendar has paged away"
 *   `applyCalendarAppointment` skipping the today list           "a row the server hands back replaces the today list's copy"
 *   `transientRefusal` taking any 5xx as transient               "a 5xx is transient on /api/me and nowhere else"
 *   `retrySessionLater` without its ceiling                      "the sixth refusal in a row is the last"
 *   `clearSessionRetry` dropped from sign-in or sign-out         "a pending retry is dropped on sign-in and sign-out"
 with credit on                                     "the balance line names the bill and what credit covers"
 *   `toast()` without `showPopover`                                "the toast is lifted into the top layer"
 *   `petNotesMarkup` bracketing the kind again                     "a pet note's kind is a label"
 *   `clientPetsPanelMarkup` in record order in a rail              "the visit's own pet leads its rail"
 *   `.primary:hover` back to ink                                    "a hovered primary is the brand's strong step"
 *   the create form's Staff back above Start                        "the block-time create form has the drawer's shape"
 *   the head paginator restored                                     "the history table has one paginator"
 *
 * Each was applied, run against this file, and reverted.
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

/** One CSS rule's declarations, by its exact selector, wherever it sits in the sheet. */
function rule(selector: string, within = styles): string {
  const index = within.indexOf(`${selector}{`);
  if (index < 0) throw new Error(`public/styles.css no longer contains ${JSON.stringify(selector)}`);
  return within.slice(index + selector.length + 1, within.indexOf("}", index));
}

/** A media block's text, by its exact query, for a rule that only holds inside it. */
function media(query: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const at = styles.indexOf(`@media(${query}){`, from);
    if (at < 0) break;
    let depth = 0;
    let index = at + query.length + 9;
    for (; index < styles.length; index += 1) {
      if (styles[index] === "{") depth += 1;
      if (styles[index] === "}") { if (depth === 0) break; depth -= 1; }
    }
    blocks.push(styles.slice(at, index));
    from = index;
  }
  if (!blocks.length) throw new Error(`public/styles.css has no @media(${query}) block`);
  return blocks;
}

function build<T>(body: string, scope: Record<string, unknown>): T {
  const names = Object.keys(scope);
  return (new Function(...names, body) as (...args: unknown[]) => T)(...names.map((name) => scope[name]));
}

/** A DOMRect-shaped box. */
const box = (top: number, left: number, width: number, height: number) =>
  ({ top, left, width, height, bottom: top + height, right: left + width });

// ─── RC-01 · the grid takes the viewport ───────────────────────────────────────────────────

describe("the calendar scroll box is sized to the viewport, not a fraction of it", () => {
  it("the scroll box is sized to the viewport", () => {
    const scroll = rule(".week-scroll");
    expect(scroll).not.toMatch(/max-height:\d+vh/u);
    expect(scroll).toContain("height:max(320px,calc(100dvh - var(--calendar-chrome,260px)))");
    // The tablet override that halved it again is gone with it.
    expect(styles).not.toContain(".week-scroll{max-height:68vh}");
  });

  it("measures the chrome above the box as it laid out, plus the page's own bottom gutter", () => {
    const SIZE = slice("function sizeCalendarScroll(){", "\nglobalThis.addEventListener(\"resize\",sizeCalendarScroll);");
    const set: string[] = [];
    const shell = { style: { setProperty: (name: string, value: string) => { set.push(`${name}=${value}`); } } };
    const main = { scrollTop: 12 };
    const scroll = { getBoundingClientRect: () => box(146.4, 0, 100, 100) };
    const elements: Record<string, unknown> = { "#calendar": shell, ".week-scroll": scroll, "#app-view main": main };
    const size = build<() => void>(`${SIZE}\nreturn sizeCalendarScroll;`, {
      $: (selector: string) => elements[selector] ?? null,
      document: { body: { dataset: { view: "calendar" } } },
      globalThis: { scrollY: 30, getComputedStyle: () => ({ paddingBottom: "16px" }) }
    });
    size();
    // 146.4 + 30 (page scrolled) + 12 (main scrolled) + 16 (gutter) = 204.4, rounded.
    expect(set).toEqual(["--calendar-chrome=204px"]);
  });

  it("measures nothing while another view is on screen, where a hidden box has no geometry", () => {
    const SIZE = slice("function sizeCalendarScroll(){", "\nglobalThis.addEventListener(\"resize\",sizeCalendarScroll);");
    const set: string[] = [];
    const size = build<() => void>(`${SIZE}\nreturn sizeCalendarScroll;`, {
      $: () => ({ style: { setProperty: (name: string) => { set.push(name); } }, getBoundingClientRect: () => box(0, 0, 0, 0), scrollTop: 0 }),
      document: { body: { dataset: { view: "dashboard" } } },
      globalThis: { scrollY: 0, getComputedStyle: () => ({ paddingBottom: "16px" }) }
    });
    size();
    expect(set).toEqual([]);
  });

  it("every paint redraws the toolbar from the same state, sizes the box and reveals the period", () => {
    const paint = slice("function renderCalendar(){", "\n// --- The calendar's scroll box");
    expect(paint).toContain("updateCalendarViewControls();sizeCalendarScroll();revealCalendarPeriod();");
  });

  it("month rows are content-driven from a floor of a few lines, at every pointer and width", () => {
    expect(styles).toContain(".calendar-month-day{display:flex;flex-direction:column;gap:2px;min-height:110px;padding:5px 5px 4px}");
    expect(styles).not.toMatch(/\.calendar-month-day\{min-height:3\d\dpx\}/u);
  });
});

// ─── RC-05 · where the calendar opens ───────────────────────────────────────────────────────

describe("where each view opens", () => {
  const REVEAL = slice("let calendarRevealKey=null;", "\n// A month cell is as tall as its busiest day");
  const DATE = slice("function revealCalendarDate(date,{behavior=\"smooth\"}={}){", "\n$(\"#calendar-today\")");

  interface Reveal { reveal(): void; scrolled: unknown[]; scroll: { scrollLeft: number; scrollTop: number } }
  function harness({ view, phone, heads, busy = 0, onScreen = "calendar", month = null as null | { top: number } }:
    { view: string; phone: boolean; heads: Record<string, { offsetLeft: number; offsetWidth: number }>; busy?: number; onScreen?: string; month?: null | { top: number } }): Reveal {
    const scrolled: unknown[] = [];
    const scroll = {
      scrollLeft: 0, scrollTop: 0, clientWidth: 364,
      scrollTo: (target: unknown) => { scrolled.push(target); },
      getBoundingClientRect: () => box(200, 0, 364, 500),
      querySelector: (selector: string) => {
        const date = /data-calendar-date="([^"]+)"/u.exec(selector)?.[1];
        if (date) return heads[date] ?? null;
        const column = /data-day-column="([^"]+)"/u.exec(selector)?.[1];
        if (column !== undefined) return { offsetLeft: 58 + Number(column) * 136, offsetWidth: 136 };
        if (selector === ".day-corner" || selector === ".week-time") return { offsetWidth: 58 };
        if (selector === ".calendar-month-weekday") return { offsetHeight: 30 };
        if (selector.startsWith(".calendar-month-day")) return month && { getBoundingClientRect: () => box(month.top, 0, 100, 110) };
        return null;
      }
    };
    const state = { calendar: { displayMode: "calendar", view, selectedDate: "2026-09-21", weekStart: "2026-09-20", month: "2026-09", firstBusyColumn: busy } };
    const reveal = build<() => void>(`${REVEAL}\n${DATE}\nreturn revealCalendarPeriod;`, {
      $: (selector: string) => (selector === ".week-scroll" ? scroll : null),
      document: { body: { dataset: { view: onScreen } } },
      state,
      calendarPhoneWidth: () => phone
    });
    return { reveal, scrolled, scroll };
  }

  it("a phone opens the week on the selected date's column, not the closed Sunday", () => {
    const app = harness({ view: "week", phone: true, heads: { "2026-09-21": { offsetLeft: 378, offsetWidth: 320 } } });
    app.reveal();
    expect(app.scrolled).toEqual([{ left: 320, behavior: "auto" }]);
  });

  it("a desktop nudges the week only when that column is off-screen", () => {
    const fits = harness({ view: "week", phone: false, heads: { "2026-09-21": { offsetLeft: 58, offsetWidth: 150 } } });
    fits.reveal();
    expect(fits.scrolled).toEqual([]);
    const beyond = harness({ view: "week", phone: false, heads: { "2026-09-21": { offsetLeft: 900, offsetWidth: 150 } } });
    beyond.reveal();
    expect(beyond.scrolled).toEqual([{ left: 842, behavior: "auto" }]);
  });

  it("a phone opens the day on the first column that has anything on it", () => {
    const app = harness({ view: "day", phone: true, heads: {}, busy: 1 });
    app.reveal();
    expect(app.scroll.scrollLeft).toBe(136);
  });

  it("the day grid on a desktop is left where it is", () => {
    const app = harness({ view: "day", phone: false, heads: {}, busy: 1 });
    app.reveal();
    expect(app.scroll.scrollLeft).toBe(0);
  });

  it("the month scrolls to today's row only when that row is not already in view", () => {
    const visible = harness({ view: "month", phone: false, heads: {}, month: { top: 300 } });
    visible.reveal();
    expect(visible.scroll.scrollTop).toBe(0);
    const below = harness({ view: "month", phone: false, heads: {}, month: { top: 900 } });
    below.reveal();
    // 900 - 200 (box top) - 30 (sticky weekday row) = 670.
    expect(below.scroll.scrollTop).toBe(670);
  });

  it("one reveal per period, and none while the calendar is behind another view", () => {
    const heads = { "2026-09-21": { offsetLeft: 378, offsetWidth: 320 } };
    const app = harness({ view: "week", phone: true, heads });
    app.reveal(); app.reveal();
    expect(app.scrolled).toHaveLength(1);
    const hidden = harness({ view: "week", phone: true, heads, onScreen: "dashboard" });
    hidden.reveal();
    expect(hidden.scrolled).toEqual([]);
  });

  it("the phone day lane floor is one number, in app.js and in the stylesheet", () => {
    const lanes = /const DAY_LANE_WIDTH=(\d+),DAY_LANE_WIDTH_PHONE=(\d+),DAY_GUTTER_WIDTH=(\d+),DAY_GUTTER_WIDTH_PHONE=(\d+);/u.exec(source);
    expect(lanes).not.toBeNull();
    const [, desktop, phone, gutter, phoneGutter] = lanes!;
    expect(rule(".day-grid")).toContain(`grid-template-columns:${gutter}px repeat(var(--groomer-count),minmax(${desktop}px,1fr))`);
    expect(media("max-width:580px").some((block) =>
      block.includes(`.day-grid{--slot-height:44px;grid-template-columns:${phoneGutter}px repeat(var(--groomer-count),minmax(${phone}px,1fr))}`))).toBe(true);
    // Two lanes and the gutter fit a 360px phone: 360 - 14px of page gutter a side - 1px of border a side.
    expect(Number(phoneGutter) + 2 * Number(phone)).toBeLessThanOrEqual(360 - 28 - 2);
  });
});

// ─── RC-02 · the card menu leaves the grid ───────────────────────────────────────────────────

describe("the card menu is drawn in the top layer, beside its trigger", () => {
  const LIFT = slice("function liftCalendarPopover(popover,open){", "\ndocument.addEventListener(\"scroll\",followCalendarPopover");

  interface Menu { lift(popover: unknown, open: boolean): void; follow(): void; closed: number }
  function harness(trigger: ReturnType<typeof box>, size: ReturnType<typeof box>, viewport = { innerWidth: 1280, innerHeight: 800 }) {
    const attributes = new Map<string, string>();
    const style: Record<string, string> = {};
    let shown = false;
    const gridBox = box(146, 0, 1200, 640);
    const triggerElement = { getBoundingClientRect: () => trigger, closest: () => ({ getBoundingClientRect: () => gridBox }) };
    const popover = {
      hidden: false,
      previousElementSibling: triggerElement,
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
      removeAttribute: (name: string) => { attributes.delete(name); },
      showPopover: () => { shown = true; },
      hidePopover: () => { shown = false; },
      matches: (selector: string) => selector === ":popover-open" && shown,
      getBoundingClientRect: () => size,
      style: { ...style, removeProperty: (name: string) => { delete style[name]; }, set left(value: string) { style.left = value; }, set top(value: string) { style.top = value; }, get left() { return style.left ?? ""; }, get top() { return style.top ?? ""; } }
    };
    const state = { closed: 0 };
    const module = build<Menu>(`${LIFT}\nreturn {lift:liftCalendarPopover,follow:followCalendarPopover,get closed(){return closed.closed;}};`, {
      $: () => popover,
      globalThis: viewport,
      closed: state,
      closeCalendarMenus: () => { state.closed += 1; },
      document: {}
    });
    return { ...module, popover, attributes, style, isShown: () => shown, closedCount: () => module.closed };
  }

  it("the card menu is lifted into the top layer", () => {
    const menu = harness(box(300, 500, 14, 14), box(0, 0, 170, 216));
    menu.lift(menu.popover, true);
    expect(menu.attributes.get("popover")).toBe("manual");
    expect(menu.isShown()).toBe(true);
    // Below the trigger, its right edge on the trigger's.
    expect(menu.style).toEqual({ left: "344px", top: "318px" });
    menu.lift(menu.popover, false);
    expect(menu.isShown()).toBe(false);
    expect(menu.attributes.has("popover")).toBe(false);
  });

  it("a menu with no room below opens above", () => {
    // The trigger 46px above the viewport's foot: 216px of menu cannot go under it.
    const menu = harness(box(754, 500, 14, 14), box(0, 0, 170, 216));
    menu.lift(menu.popover, true);
    expect(menu.style.top).toBe("534px");
  });

  it("a menu near the left edge is kept on screen", () => {
    const menu = harness(box(300, 60, 14, 14), box(0, 0, 170, 216));
    menu.lift(menu.popover, true);
    expect(menu.style.left).toBe("8px");
  });

  it("a trigger scrolled out of the grid's box takes its menu with it", () => {
    const menu = harness(box(900, 500, 14, 14), box(0, 0, 170, 216));
    menu.lift(menu.popover, true);
    menu.follow();
    expect(menu.closedCount()).toBe(1);
  });

  it("the top-layer menu is positioned by the script, not centred by the popover's own styles", () => {
    expect(rule(".calendar-action-popover[popover]")).toContain("position:fixed;inset:auto;top:0;left:0;right:auto;margin:0");
  });

  it("opening the menu lifts it, in the one handler that opens it", () => {
    const handler = slice("find('[data-appointment-menu]').forEach(", "find('.calendar-action-popover').forEach(");
    expect(handler).toContain("if(opening){liftCalendarPopover(popover,true);");
    expect(slice("function closeCalendarMenus(", "\n// THE MENU IS DRAWN IN THE TOP LAYER")).toContain("liftCalendarPopover(popover,false);");
  });
});

// ─── RC-04 · a status is a treatment, not a code ─────────────────────────────────────────────

describe("a cancelled or no-show visit reads as one", () => {
  it("the card class carries one treatment: muted tint, struck name, dimmed", () => {
    const treatment = rule(".appointment-block.status-cancelled,.appointment-block.status-no_show");
    expect(treatment).toContain("--g:var(--muted)");
    expect(treatment).toContain("--g-tint:var(--surface-2)");
    expect(treatment).toContain("opacity:.6");
    expect(rule(".appointment-block.status-cancelled .appointment-pet,.appointment-block.status-no_show .appointment-pet"))
      .toContain("text-decoration:line-through");
    // Written after the groomer tint tokens it overrides, so the cascade reads the card's status last.
    expect(styles.indexOf(".appointment-block.status-cancelled,")).toBeGreaterThan(styles.indexOf('[data-groomer-slot="9"],[data-block-slot="9"]'));
  });

  it("the surface head wears the cards' badge and, for a visit that will not happen, says so in a banner", () => {
    const head = slice("  const head=`<header class=\"surface-head\">`", "\n  // The rail is clientSummaryMarkup() verbatim");
    expect(head).toContain('class="appointment-status appointment-badge badge-${escape(item.status)}" data-testid="appointment-status">${escape(model.status)}</span>');
    expect(head).toContain('data-testid="appointment-status-banner"');
    expect(head).toContain('["cancelled","no_show"].includes(item.status)');
    // Inside the <header>, where the shell's three declared rows are not disturbed by a fourth child.
    expect(head.indexOf("appointment-status-banner")).toBeLessThan(head.indexOf("+`</header>`"));
    expect(rule(".surface-head .appointment-status.appointment-badge")).toContain("border-radius:999px;font-size:11px");
    expect(rule(".surface-banner")).toContain("grid-column:1/-1");
  });
});

// ─── RC-13 · a nav item the route will refuse is not drawn ───────────────────────────────────

describe("the Clients navigation", () => {
  it("the Clients item is gated on what the route needs", () => {
    const item = /<button[^>]*data-testid="nav-customers"[^>]*>/u.exec(markup)![0];
    expect(item).toContain('data-permission="customers.view"');
    expect(item).not.toContain("data-any-permission");
    expect(item).not.toContain("pets.view");
  });

  it("a refused view load is spoken, not swallowed", () => {
    const view = slice("async function showView(view,{history=\"push\"}={}) {", "\nfunction activateView(");
    const failure = view.slice(view.indexOf("}catch(error){"));
    expect(failure).not.toMatch(/(return|await) bootstrap\(\)/u);
    expect(failure).toContain("if(error?.status===401)return;");
    expect(failure).toContain("toast(error.message);");
    expect(failure).toContain("updateCalendarViewControls();");
    // The nav button by name - `<body data-view>` already carries the view and would answer first.
    expect(failure).toContain('$(`#primary-navigation [data-view="${view}"]`)?.hidden');
  });
});

// ─── RC-14 · a rate limit is not a sign-out ──────────────────────────────────────────────────

describe("a refusal the server will withdraw on its own", () => {
  const TRANSIENT = slice("const RATE_LIMIT_BODY=", "\n// One timer, so a resume and a bootstrap");
  const module = build<{ transient(error: unknown): boolean; after(response: unknown, result: unknown): number }>(
    `${TRANSIENT}\nreturn {transient:transientRefusal,after:retryAfterSeconds};`, {});
  const headers = (value: string | null) => ({ headers: { get: () => value } });

  it("a rate limit is not a sign-out", () => {
    expect(module.transient({ status: 429 })).toBe(true);
    expect(module.transient({ status: 429, path: "/api/employees" })).toBe(true);
    // The older shape, by its body, so the client reads either while the server moves between them.
    expect(module.transient({ status: 400, data: { error: "Rate limit exceeded, retry in 12 seconds" } })).toBe(true);
    expect(module.transient({ status: 400, data: { code: "RATE_LIMITED", error: "Too many requests." } })).toBe(true);
    expect(module.transient({ status: 401 })).toBe(false);
    expect(module.transient({ status: 403, data: { error: "Missing permission: customers.view" } })).toBe(false);
    expect(module.transient({ status: 400, data: { error: "Transfer ownership before removing an Owner" } })).toBe(false);
  });

  it("a 5xx is transient on /api/me and nowhere else", () => {
    expect(module.transient({ status: 503, path: "/api/me" })).toBe(true);
    expect(module.transient({ status: 500, path: "/api/me?x=1" })).toBe(true);
    expect(module.transient({ status: 503, path: "/api/reports" })).toBe(false);
    expect(module.transient({ status: 500 })).toBe(false);
    expect(slice("async function api(path, options = {}) {", "\n/**\n * A REFUSAL THE SERVER WILL WITHDRAW")).toContain("error.path = path;");
  });

  // The retry scheduler against a fake clock: what it toasts, when it fires, and when it stops.
  function retryHarness() {
    const RETRY = slice("const SESSION_RETRY_LIMIT=", "\n\n/**\n * PERMISSION COPY");
    const toasts: string[] = [];
    const timers: { fn: () => void; ms: number; id: number }[] = [];
    let settled = 0;
    let nextId = 1;
    const module = build<{ retry(error: unknown, task: () => void): void; clear(): void; pending(): boolean; count(): number }>(
      `${RETRY}\nreturn {retry:retrySessionLater,clear:clearSessionRetry,pending:()=>sessionRetryTimer!==null,count:()=>sessionRetries};`, {
        toast: (message: string) => { toasts.push(message); },
        settleUnauthenticated: () => { settled += 1; },
        runDetached: (task: () => void) => { task(); },
        globalThis: {
          setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.push({ fn, ms, id }); return id; },
          clearTimeout: (id: number) => { const at = timers.findIndex((timer) => timer.id === id); if (at >= 0) timers.splice(at, 1); }
        }
      });
    return { ...module, toasts, timers, settled: () => settled };
  }

  it("the sixth refusal in a row is the last", () => {
    const app = retryHarness();
    const ran: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      app.retry({ retryAfterSeconds: 2 }, () => { ran.push(attempt); });
      expect(app.pending()).toBe(true);
      expect(app.timers.at(-1)!.ms).toBe(2_000);
      app.timers.pop()!.fn();
    }
    expect(ran).toEqual([1, 2, 3, 4, 5]);
    expect(app.toasts).toEqual(Array(5).fill("Busy, retrying in 2 s"));
    // The sixth: no timer, one sentence, the sign-in page - and the count is back at nought.
    app.retry({ retryAfterSeconds: 2 }, () => { ran.push(6); });
    expect(ran).toHaveLength(5);
    expect(app.pending()).toBe(false);
    expect(app.settled()).toBe(1);
    expect(app.toasts.at(-1)).toBe("Couldn't reach Pawsh — sign in again");
    expect(app.count()).toBe(0);
  });

  it("a pending retry is dropped on sign-in and sign-out", () => {
    const app = retryHarness();
    app.retry({ retryAfterSeconds: 5 }, () => {});
    expect(app.pending()).toBe(true);
    app.clear();
    expect(app.pending()).toBe(false);
    expect(app.timers).toEqual([]);
    expect(app.count()).toBe(0);
    // The two doors: the sign-in form's submit, and the session ending.
    const submit = slice('$("#auth-form").addEventListener("submit", async (event) => {', "\n});");
    expect(submit.indexOf("clearSessionRetry();")).toBeLessThan(submit.indexOf("await api("));
    const ended = slice("function settleUnauthenticated() {", "\n}");
    expect(ended).toContain("clearSessionRetry();");
    // And a session that lands starts the count over.
    expect(slice("async function bootstrap() {", "\nasync function refresh() {")).toContain("await refresh();\n    sessionRetries=0;");
    expect(slice("async function resumeSession(){", "\n/** Whether a timer tick may repaint")).toContain("await refresh();sessionRetries=0;");
  });

  it("the retry delay comes from Retry-After first, the older sentence next, and five seconds last", () => {
    expect(module.after(headers("2"), {})).toBe(2);
    expect(module.after(headers("0.4"), {})).toBe(1);
    expect(module.after(headers(null), { error: "Rate limit exceeded, retry in 7 seconds" })).toBe(7);
    expect(module.after(headers(null), { error: "Something else" })).toBe(5);
  });

  it("a busy /api/me on resume retries", () => {
    const resume = slice("async function resumeSession(){", "\n/** Whether a timer tick may repaint");
    expect(resume).toContain("if(transientRefusal(error)){retrySessionLater(error,resumeSession);return;}");
    const boot = slice("async function bootstrap() {", "\nasync function refresh() {");
    expect(boot).toContain("if(transientRefusal(error)){retrySessionLater(error,bootstrap);return;}");
    // The toast says how long, and only a real refusal puts the sign-in page up.
    expect(slice("function retrySessionLater(error,task){", "\n}")).toContain("toast(`Busy, retrying in ${seconds} s`);");
  });

  it("every api() error carries its retry delay for the callers that branch on it", () => {
    expect(slice("async function api(path, options = {}) {", "\n/**\n * A REFUSAL THE SERVER WILL WITHDRAW"))
      .toContain("error.retryAfterSeconds = retryAfterSeconds(response, result);");
  });
});

// ─── RC-12 · every action resolves the row it was pressed on ─────────────────────────────────

describe("the one appointment resolver", () => {
  const RESOLVER = slice("function appointmentCaches(){", "\n// The hover host is whichever");
  function harness() {
    const state = { appointments: [] as { id: string; v: number }[], calendar: { monthAppointments: [] as { id: string; v: number }[] }, todayAppointments: [] as { id: string; v: number }[] };
    let painted = 0;
    const module = build<{ byId(id: string): unknown; apply(row: unknown): void }>(
      `${RESOLVER}\nreturn {byId:calendarAppointmentById,apply:applyCalendarAppointment};`,
      { state, renderAppointments: () => { painted += 1; } });
    return { ...module, state, painted: () => painted };
  }

  it("a today row is found once the calendar has paged away", () => {
    const app = harness();
    // The calendar shows next week: the grid and month caches hold other days, today's list alone holds the row.
    app.state.appointments = [{ id: "next-week", v: 1 }];
    app.state.calendar.monthAppointments = [{ id: "next-week", v: 1 }];
    app.state.todayAppointments = [{ id: "today", v: 1 }];
    expect(app.byId("today")).toEqual({ id: "today", v: 1 });
    expect(app.byId("next-week")).toEqual({ id: "next-week", v: 1 });
    expect(app.byId("missing")).toBeUndefined();
  });

  it("a row the server hands back replaces the today list's copy", () => {
    const app = harness();
    app.state.appointments = [{ id: "a", v: 1 }];
    app.state.calendar.monthAppointments = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
    app.state.todayAppointments = [{ id: "a", v: 1 }];
    app.apply({ id: "a", v: 2 });
    expect(app.state.appointments).toEqual([{ id: "a", v: 2 }]);
    expect(app.state.calendar.monthAppointments).toEqual([{ id: "a", v: 2 }, { id: "b", v: 1 }]);
    expect(app.state.todayAppointments).toEqual([{ id: "a", v: 2 }]);
    expect(app.painted()).toBe(1);
  });

  it("every dashboard action goes through the resolver, and none throws on a row it cannot find", () => {
    const advance = slice("async function advanceAppointment(id, status, actionButton) {", "\n  const next = ");
    expect(advance).not.toContain("state.appointments.find(");
    expect(advance).toContain("const appointment=calendarAppointmentById(id);\n  if(!appointment)return toast(");
    for (const name of ["moveAppointment", "terminalAppointment", "adjustServices"]) {
      const body = source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}", source.indexOf(`function ${name}(`)));
      expect(body, name).toContain("record||calendarAppointmentById(id)");
    }
  });
});

// ─── RC-13 · a read the route will refuse is not sent ────────────────────────────────────────

describe("the client note thread for a role without customers.view", () => {
  const LOAD = slice("async function loadClientNotes(customerId){", "\n}") + "\n}";
  const NOTES = slice("function clientNotesMarkup(profile){", "\n  if(!notes.items.length)");

  it("a role without customers.view never asks for the notes", async () => {
    const requests: string[] = [];
    const load = build<(id: string) => Promise<{ items: unknown[]; failed: boolean; refused?: boolean; message?: string }>>(
      `${LOAD}\nreturn loadClientNotes;`, {
        allowed: (key: string) => key !== "customers.view",
        api: async (path: string) => { requests.push(path); return { items: [{ id: "n1" }], total: 1 }; },
        permissionRefusalSentence: (action: string) => `You do not have permission to ${action}`,
        CLIENT_NOTE_PAGE_SIZE: 50
      });
    const refused = await load("c1");
    expect(requests).toEqual([]);
    expect(refused).toMatchObject({ items: [], failed: true, refused: true, message: "You do not have permission to view client notes" });
    // With the permission, the same request as before.
    const allowedLoad = build<(id: string) => Promise<unknown>>(`${LOAD}\nreturn loadClientNotes;`, {
      allowed: () => true, api: async (path: string) => { requests.push(path); return { items: [], total: 0 }; },
      permissionRefusalSentence: () => "", CLIENT_NOTE_PAGE_SIZE: 50
    });
    await allowedLoad("c1");
    expect(requests).toEqual(["/api/customers/c1/notes?page=1&pageSize=50"]);
  });

  it("a refused thread is drawn without a Retry", () => {
    const markup = build<(profile: unknown) => string>(`${NOTES}\nreturn "";}\nreturn clientNotesMarkup;`, {
      allowed: () => false, escape: (value: string) => value
    });
    const html = markup({ notes: { refused: true, failed: true, message: "You do not have permission to view client notes", items: [] } });
    expect(html).toContain('data-testid="client-notes-refused"');
    expect(html).not.toContain("notes-retry");
  });

  it("the Ticket asks for each thread only when the role can read it", () => {
    const load = slice("  const refused=action=>Promise.reject(", "\n    ]);");
    expect(load).toContain('allowed("pets.view")?api(`/api/pets/');
    expect(load).toContain('allowed("customers.view")?api(`/api/customers/');
  });
});

// ─── RC-15 · the settled statement keeps its padding ─────────────────────────────────────────

describe("the settled Check Out statement", () => {
  it("the settled statement keeps the column's padding", () => {
    expect(styles).not.toContain(".checkout-settled{padding:0}");
    expect(rule(".checkout-settled")).toContain("min-width:0");
    expect(rule(".checkout-settled .receipt")).toContain("min-width:0");
  });
});

// ─── RC-16 · phone footers are bounded ───────────────────────────────────────────────────────

describe("the sticky footers on a phone", () => {
  it("the invoice footer holds the balance and the actions only", () => {
    const actions = slice("function invoiceDocumentActionsMarkup(receipt){", "\n// The sentence behind the two disabled controls");
    expect(actions).not.toContain("invoice-unavailable-note");
    // The sentence is said once, in the settlement panel, in the body.
    const workspace = slice("function invoiceWorkspaceMarkup(", "\n// Every control on the rendered copy of the workspace");
    const summary = workspace.slice(workspace.indexOf('class="invoice-summary"'), workspace.indexOf("</aside>"));
    expect(summary).toContain("invoiceUnavailableNoteMarkup()");
    expect(slice("function invoiceUnavailableNoteMarkup(){", "\n}")).toContain('data-testid="invoice-unavailable-note"');
  });

  it("the invoice footer is a 2x2 of compact actions under the balance at phone width", () => {
    const phone = media("max-width:640px").find((block) => block.includes(".invoice-foot{"))!;
    expect(phone).toContain(".invoice-foot>.surface-foot-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 6px}");
    expect(phone).toContain("min-height:var(--control-h-compact)");
  });

  it("the Check Out footer names its two zones and seats the balance beside the primary on a phone", () => {
    const phone = media("max-width:640px").find((block) => block.includes("#appointment-checkout .checkout-foot{"))!;
    expect(phone).toContain("#appointment-checkout .checkout-foot>.checkout-balance{grid-row:1;grid-column:1");
    expect(phone).toContain("#appointment-checkout .checkout-foot>.surface-foot-lead{grid-row:1;grid-column:2");
    expect(phone).toContain("#appointment-checkout .checkout-foot>.surface-foot-utility{grid-row:2;grid-column:1/-1");
    // Disabled controls are drawn disabled, never dropped: the utility row wraps rather than hides.
    expect(phone).toContain("flex-wrap:wrap");
  });
});

// ─── RC-06 · the booking rail on a phone ─────────────────────────────────────────────────────

describe("the booking rail", () => {
  it("the booking rail is one column on a phone", () => {
    const tablet = media("max-width:900px").find((block) => block.includes(".booking-client{"))!;
    expect(tablet).toContain(".booking-client{display:block;");
  });
});

// ═══ Batch 2b · the P2/P3 rows, by root cause ═══════════════════════════════════════════════

const escapeHtml = (value = "") => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// ─── RC-03 · only the safety alert is an alarm ───────────────────────────────────────────────

describe("the pet's care notes", () => {
  const CARE = slice("function petCareNotes(item){", "\n// Pet care notes plus the appointment's own note.");
  const module = build<{ notes(item: unknown): { kind: string; value: string; alarm: boolean }[]; markup(note: unknown, options?: unknown): string }>(
    `${CARE}\nreturn {notes:petCareNotes,markup:careNoteMarkup};`, { escape: escapeHtml });
  const pet = { safetyAlerts: "May snap during nails.", behaviorNotes: "Friendly and calm.", medicalNotes: "  ", groomingPreferences: "Medium trim", coatNotes: "Long double coat" };

  it("only the safety alert is an alarm", () => {
    expect(module.notes(pet)).toEqual([
      { kind: "Safety alert", value: "May snap during nails.", alarm: true },
      { kind: "Behavior", value: "Friendly and calm.", alarm: false },
      { kind: "Grooming", value: "Medium trim", alarm: false },
      { kind: "Coat", value: "Long double coat", alarm: false }
    ]);
    const [alarm, plain] = module.notes(pet);
    expect(module.markup(alarm)).toBe('<p class="care-note care-alarm"><strong class="note-kind">Safety alert:</strong> May snap during nails.</p>');
    expect(module.markup(plain)).toBe('<p class="care-note"><strong class="note-kind">Behavior:</strong> Friendly and calm.</p>');
    expect(module.markup(alarm, { pill: true })).toContain('class="agenda-warning"');
    expect(module.markup(plain, { pill: true })).toContain('class="agenda-note"');
  });

  it("the model's warning is the alarm alone, and every surface reads the list", () => {
    const presentation = slice("function appointmentPresentation(item){", "\nfunction appointmentAccessibleName(");
    expect(presentation).toContain('warning:item.safetyAlerts||"",careNotes:');
    expect(presentation).not.toContain("item.safetyAlerts||item.behaviorNotes");
    // The agenda row and the surface's Pet block draw the list, never the folded string.
    expect(slice("function renderAgendaCalendar(){", "\n// A month cell is as tall")).toContain("careNoteMarkup(note,{pill:true})");
    const pet = slice('<div class="work-block"><div class="work-block-head"><h3>Pet</h3></div>', "appointment-services-block");
    expect(pet).toContain('data-testid="appointment-care-notes"');
    expect(pet).not.toContain("detail-warning");
    expect(rule(".detail-care-notes .care-alarm,.detail-care-notes .care-alarm .note-kind")).toContain("var(--danger)");
    expect(rule(".agenda-note")).toContain("color:var(--muted)");
  });
});

// ─── RC-04 · the strip: time first, words where there is room ────────────────────────────────

describe("the card head", () => {
  it("a card badge carries the word and the code", () => {
    const head = slice("  const badges=`<span class=\"appointment-badges\">", "\n  const head=");
    expect(head).toContain('<span class="badge-word">${escape(badge.label)}</span><span class="badge-code">${badge.code}</span>');
    expect(rule(".density-medium .appointment-badge .badge-word,.density-long .appointment-badge .badge-word")).toBe("display:inline");
    expect(rule(".density-brief .appointment-badge .badge-code,.density-short .appointment-badge .badge-code")).toBe("display:inline");
    // A card narrower than 150px - a week lane split between groomers - falls back to the code.
    // The container rule must carry the density prefix, or it is a class short of the rule it
    // overrides and the card draws the word AND the code.
    expect(styles).toContain("@container (max-width:150px){.density-medium .appointment-badge .badge-word,.density-long .appointment-badge .badge-word{display:none}.density-medium .appointment-badge .badge-code,.density-long .appointment-badge .badge-code{display:inline}}");
    expect(styles).not.toMatch(/@container \(max-width:150px\)\{\.appointment-badge \.badge-word/u);
  });

  it("the time never gives way in the strip", () => {
    // The convergence rule comes after the strip's own and wins the cascade.
    const elastic = styles.indexOf(".appointment-block .appointment-time{flex:1 1 auto");
    const fixed = styles.indexOf(".appointment-block .appointment-time{flex:0 0 auto;overflow:visible;text-overflow:clip}");
    expect(fixed).toBeGreaterThan(elastic);
    expect(styles).toContain(".appointment-block .appointment-badges{flex:0 1 auto;min-width:0;overflow:hidden}");
    expect(rule(".agenda-indicators .appointment-status.appointment-badge")).toContain("border-radius:999px;font-size:11px");
  });
});

// ─── RC-05 · what a drag shows, and where a booking lands ───────────────────────────────────

describe("the drag and the landing", () => {
  it("edge auto-scroll stops at the grid's last row", () => {
    const LIMIT = slice("function calendarDragScrollLimit(container){", "\nfunction beginCalendarDrag(){");
    const limit = build<(container: unknown) => number>(`${LIMIT}\nreturn calendarDragScrollLimit;`, {});
    // A transformed card has grown the scroll area to 2000; the last time cell ends at 1100.
    const container = { clientHeight: 500, scrollHeight: 2000, querySelectorAll: () => [{ offsetTop: 1064, offsetHeight: 36 }] };
    expect(limit(container)).toBe(600);
    expect(limit({ clientHeight: 500, scrollHeight: 900, querySelectorAll: () => [] })).toBe(400);
    const frame = slice("function calendarDragFrame(){", "\n// THE GRID'S OWN FOOT");
    expect(frame).toContain("Math.min(calendarDragScrollLimit(container)-container.scrollTop,");
  });

  it("the drop preview is see-through and the carried card lighter", () => {
    expect(styles).toContain(".calendar-drop-preview{background:rgba(47,111,98,.16);background:color-mix(in srgb,var(--brand) 16%,transparent)}");
    expect(styles).toContain(".appointment-block.dragging{opacity:.8}");
    expect(rule(".day-corner,.week-corner")).toContain("box-shadow:1px 0 0 var(--line)");
  });

  it("the move question names the pet and both times", () => {
    const QUESTION = slice("function moveQuestion(appointment,localStart){", "\n/**\n * Every drop asks first.");
    const ask = build<(appointment: unknown, localStart: string) => string>(`${QUESTION}\nreturn moveQuestion;`, {
      appointmentLocalValue: () => "2026-09-21T13:00",
      timeLabel: (minutes: number) => `${((Math.floor(minutes / 60) + 11) % 12) + 1}:${String(minutes % 60).padStart(2, "0")} ${minutes >= 720 ? "PM" : "AM"}`,
      formatPrefLocalDate: (date: string) => date.split("-").reverse().join("/"),
      petName: ({ petName }: { petName: string }) => petName,
      dropConfirmDestination: () => "unused"
    });
    const mochi = { petName: "Mochi" };
    expect(ask(mochi, "2026-09-21T14:45")).toBe("Move Mochi from 1:00 PM to 2:45 PM on 21/09/2026?");
    expect(ask(mochi, "2026-09-23T10:00")).toBe("Move Mochi from 21/09/2026 1:00 PM to 23/09/2026 10:00 AM?");
    // The drag confirmation and the Move dialog both say who and from when.
    expect(slice("function confirmAppointmentDrop(", "\n    });")).toContain('title:"Reschedule appointment"');
    expect(source).not.toContain("Re-schedule appointment");
    expect(slice("function moveAppointment(id,preset={},record=null) {", "\n}")).toContain('data-testid="move-current-slot"');
  });

  it("a booked or moved card is scrolled into the box", async () => {
    const REVEAL = slice("async function revealCalendarAppointment(id,date=null){", "\nfunction revealCalendarDate(");
    const classes: string[] = [];
    const card = { getBoundingClientRect: () => box(1200, 40, 150, 60), classList: { add: (name: string) => { classes.push(name); }, remove: () => {} } };
    const scroll = { scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => box(200, 0, 800, 500),
      querySelector: (selector: string) => selector.startsWith("[data-appointment-id") ? card : selector.startsWith(".week-day-head") ? { offsetHeight: 52 } : { offsetWidth: 64 } };
    const paged: string[] = [];
    const reveal = build<(id: string, date?: string) => Promise<void>>(`${REVEAL}\nreturn revealCalendarAppointment;`, {
      $: () => scroll, document: { body: { dataset: { view: "calendar" } } },
      calendarRangeCovers: (_range: unknown, date: string) => date !== "2026-09-23",
      calendarDisplayRange: () => ({}), selectCalendarDate: async (date: string) => { paged.push(date); },
      globalThis: { setTimeout: () => 0 }
    });
    await reveal("a1", "2026-09-23");
    expect(paged).toEqual(["2026-09-23"]);
    // 1200 (card top) - 200 (box top) - 52 (sticky head) - 8 = 940; the card's left is under the gutter, so it scrolls too.
    expect(scroll.scrollTop).toBe(940);
    expect(scroll.scrollLeft).toBe(0);
    expect(classes).toEqual(["calendar-revealed"]);
    // Called from the three places a card is produced.
    expect(slice("async function dropAppointment(", "\n}")).toContain("revealCalendarAppointment(id);");
    expect(slice('    const created=await schedulingMutation("/api/appointments",{', "\n  }catch(problem){")).toContain("revealCalendarAppointment(created?.id)");
  });
});

// ─── RC-08 · the shared dialog ───────────────────────────────────────────────────────────────

describe("the shared dialog", () => {
  it("the shared dialog carries no generic kicker", () => {
    expect(markup).not.toContain("Pawsh workflow");
    expect(/<div class="modal-head"><div><h3 id="modal-title">/u.test(markup)).toBe(true);
    // The drawer keeps the one kicker that names a context.
    expect(source).toContain('<div><p class="eyebrow">Calendar</p><h3 id="blocked-time-dialog-title">Block Time</h3></div>');
  });

  it("the blank band before the footer is gone and the footer is sticky on a phone", () => {
    expect(rule("#modal-error:empty")).toBe("min-height:0;margin:0");
    expect(media("max-width:580px").some((block) => block.includes("#modal .modal-actions{position:sticky;bottom:0"))).toBe(true);
  });

  it("inline note editors order Cancel then Save", () => {
    for (const kind of ["appointment-note", "appointment-service-note"]) {
      const actions = slice(`data-testid="${kind}-cancel"`, "</div>`;");
      expect(actions.indexOf(`${kind}-cancel`)).toBeLessThan(actions.indexOf(`${kind}-save`));
    }
    expect(rule(".appointment-note-actions{justify-self:end;justify-content:flex-end}".replace(/\{.*$/u, ""))).toBeTruthy();
    expect(styles).toContain(".appointment-note-actions{justify-self:end;justify-content:flex-end}");
  });

  it("the services fieldset is a section with a field's heading", () => {
    expect(rule(".service-options>legend")).toContain("font-size:13px;font-weight:600");
    expect(styles).toContain(".service-options{min-width:0;margin:0 0 16px;padding:0;border:0}");
  });
});

// ─── RC-09 · one way to write a length of time ───────────────────────────────────────────────

describe("durations", () => {
  it("one way to write a length of time", () => {
    const LIFECYCLE = slice("function lifecycleDurationLabel(minutes){", "\n/**\n * Checked in, checked out and duration - THE STORED COLUMNS FIRST");
    const labels = build<{ lifecycle(minutes: number | null): string; one(minutes: number): string }>(`${LIFECYCLE}\nreturn {lifecycle:lifecycleDurationLabel,one:durationLabel};`, {});
    expect(labels.one(90)).toBe("90 min");
    expect(labels.one(67)).toBe("67 min");
    expect(labels.lifecycle(null)).toBe("not recorded");
    expect(labels.lifecycle(120)).toBe("120 min");
    const ticket = build<(minutes: number) => string>(`${slice("function ticketDurationLabel(minutes){", "\n}")}\n}\nreturn ticketDurationLabel;`, {});
    expect(ticket(90)).toBe("90 min");
    const history = build<(item: unknown) => string>(`${slice("function appointmentDurationLabel(item){", "\n}")}\n}\nreturn appointmentDurationLabel;`, { durationLabel: labels.one });
    expect(history({ startAt: "2026-09-21T16:00:00Z", endAt: "2026-09-21T17:30:00Z" })).toBe("90 min");
  });
});

// ─── RC-10 / RC-11 · the focus ring and the swatch caption ───────────────────────────────────

describe("the focus ring and the swatch picker", () => {
  it("every focus ring is the brand ring", () => {
    expect(styles).toContain("--focus-ring:#2f6f62;");
    expect(styles).not.toContain("179,38,30");
    for (const selector of [".time-picker-trigger:focus-visible", ".time-picker-options:focus-visible", ".calendar-block-open:focus-visible"]) {
      expect(rule(selector), selector).toContain("var(--focus-ring)");
    }
    expect(rule(".settings-content:focus-visible")).toContain("var(--focus-ring)");
  });

  it("the swatch caption sits inside its tile", () => {
    expect(rule(".staff-swatch.is-none,.staff-swatch.is-auto")).toContain("flex-direction:column");
    expect(rule(".staff-swatch-auto{position:static;line-height:1;font-size:9px}".replace(/\{.*$/u, ""))).toContain("position:absolute");
    expect(styles).toContain(".staff-swatch-auto{position:static;line-height:1;font-size:9px}");
  });
});

// ─── RC-15 / RC-16 · the balance line and the toast ──────────────────────────────────────────

describe("the Check Out balance line and the toast", () => {
  it("the balance line names the bill and what credit covers", () => {
    const line = slice('const balance=dialog.querySelector(\'[data-testid="checkout-balance"]\');', "balance.textContent=parts.join(");
    expect(line).toContain("else if(onCredit&&creditCoversAll)parts.push(`Bill ${money(due)} · covered by credit`);");
    expect(line).toContain("else if(onCredit)parts.push(`Bill ${money(due)} · ${money(creditApplied)} from credit · ${money(afterCredit)} due`);");
    expect(line).toContain("else parts.push(`Balance ${money(due)}`);");
    expect(line).toContain("credit will remain");
  });

  it("the toast is lifted into the top layer", () => {
    expect(markup).toContain('<div id="toast" role="status" popover="manual"></div>');
    const TOAST = slice("let toastTimer=null;", "\n}") + "\n}";
    const calls: string[] = [];
    const host = { textContent: "", classList: { add: (name: string) => { calls.push(`add:${name}`); }, remove: () => {}, contains: () => false },
      showPopover: () => { calls.push("show"); }, matches: () => false, hidePopover: () => {}, style: { setProperty: (name: string, value: string) => { calls.push(`${name}=${value}`); } } };
    const toast = build<(message: string) => void>(`${TOAST}\nreturn toast;`, {
      $: () => host, document: { querySelectorAll: () => [{ getBoundingClientRect: () => box(700, 0, 390, 100) }] },
      setTimeout: () => 0, clearTimeout: () => {}
    });
    toast("Saved");
    expect(host.textContent).toBe("Saved");
    expect(calls).toEqual(["--toast-clear=108px", "show", "add:show"]);
    expect(rule("#toast[popover]")).toContain("bottom:calc(24px + var(--toast-clear,0px))");
    expect(media("max-width:580px").some((block) => block.includes("#toast,#toast[popover]{left:16px;right:16px;"))).toBe(true);
  });
});

// ─── RC-17 · the rail's pet card ─────────────────────────────────────────────────────────────

describe("the rail's pet card", () => {
  const CARD = slice("function petNotesMarkup(pet){", "\n// `current` marks the visit")
    + "\n" + slice("function petCardMarkup(pet,{current=false}={}){", "\n}") + "\n}"
    + "\n" + slice("function clientPetsPanelMarkup(profile){", "\n}") + "\n}";
  const scope = { escape: escapeHtml, clientAttr: escapeHtml, petName: (pet: { name: string }) => pet.name, formatPetWeight: () => "", noteStamp: () => "today",
    petFactCells: () => "<div><dt>Behavior</dt><dd>Calm</dd></div>", allowed: () => true };
  const module = build<{ notes(pet: unknown): string; panel(profile: unknown): string }>(`${CARD}\nreturn {notes:petNotesMarkup,panel:clientPetsPanelMarkup};`, scope);

  it("a pet note's kind is a label", () => {
    const html = module.notes({ safetyAlerts: "Do not shave coat.", groomingPreferences: "Scissor trim only.", updatedAt: "2026-09-21T10:00:00Z" });
    expect(html).toContain('<p class="pet-note alert"><span class="note-kind">Safety alert:</span> Do not shave coat.</p>');
    expect(html).toContain('<p class="pet-note"><span class="note-kind">Grooming:</span> Scissor trim only.</p>');
    expect(html).not.toContain("[");
  });

  it("the visit's own pet leads its rail", () => {
    const pets = [{ id: "bruno", name: "Bruno" }, { id: "poppy", name: "Poppy" }];
    const rail = module.panel({ data: { customer: {}, pets }, appointmentId: "a1", petId: "poppy" });
    expect(rail.indexOf("Poppy")).toBeLessThan(rail.indexOf("Bruno"));
    expect(rail).toContain('data-testid="pet-card-current"');
    expect(rail).toContain('<span class="pet-card-flag">This visit</span>');
    // The profile page keeps the record's own order and marks nothing.
    const profile = module.panel({ data: { customer: {}, pets }, appointmentId: null, petId: "poppy" });
    expect(profile.indexOf("Bruno")).toBeLessThan(profile.indexOf("Poppy"));
    expect(profile).not.toContain("pet-card-current");
  });

  it("the key/value grid is one column and breaks no word it does not have to", () => {
    expect(styles).toContain(".pet-fact-grid{grid-template-columns:minmax(0,1fr);gap:var(--space-1) 0}");
    expect(styles).toContain(".pet-fact-grid dd{overflow-wrap:break-word}");
  });
});

// ─── RC-18 / RC-19 · guidance, hover, disabled ───────────────────────────────────────────────

describe("guidance and button colour", () => {
  it("a hovered primary is the brand's strong step", () => {
    expect(styles).toContain(".primary:hover{background:var(--brand-strong)}");
    expect(styles).not.toContain(".primary:hover{background:#202522}");
    expect(styles).toContain(".secondary:disabled:hover{background:var(--paper)}");
  });

  it("the pending service note is labelled guidance", () => {
    const pending = slice('data-testid="appointment-service-note-pending"', "</p>`");
    expect(pending).toContain('<span class="note-kind">Opens at check-in.</span>');
    expect(slice("      ? `<p class=\"note-empty note-guidance\"", "\n").length).toBeGreaterThan(0);
    expect(rule(".new-action-menu button:disabled small,.account-menu button:disabled small")).toContain("color:var(--muted)");
  });
});

// ─── RC-20 · one block-time form shape ───────────────────────────────────────────────────────

describe("the block-time forms", () => {
  it("the block-time create form has the drawer's shape", () => {
    const create = slice('    openModal("Block Time",', "\n      async form=>{");
    const order = ['name:"startAt"', 'name:"endAt"', 'select("employeeId","Staff"', "blockedTimeColoursMarkup(null,true", 'field("reason","Note"'];
    const positions = order.map((needle) => create.indexOf(needle));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(source).not.toContain('openModal("Block team time"');
    // One clock per field in the drawer, and room for the meridiem.
    expect(styles).toContain('.blocked-time-schedule input[type="time"]::-webkit-calendar-picker-indicator{display:none}');
    expect(rule('.blocked-time-schedule input[type="time"]')).toContain("min-width:104px");
  });
});

// ─── Responsive rows and the history paginator ───────────────────────────────────────────────

describe("the responsive rows", () => {
  it("the Ticket's tables wrap inside the paper on a phone", () => {
    expect(media("max-width:580px").some((block) => block.includes(".ticket-table{min-width:0;font-size:11.5px;table-layout:fixed}"))).toBe(true);
  });

  it("the client profile on a phone reads money and visits before the rail", () => {
    const phone = media("max-width:700px").find((block) => block.includes(".client-profile-workspace{display:flex;flex-direction:column}"))!;
    expect(phone).toContain(".client-profile-workspace>.client-profile-right{order:1");
    expect(phone).toContain(".client-profile-workspace>.client-profile-left{order:2");
    expect(phone).toContain(".profile-summary{grid-template-columns:repeat(2,minmax(0,1fr))}");
    expect(phone).toContain(".clients-name .text-button{text-align:left}");
  });

  it("the header's controls are drawn tighter below 360px, and the title is not forced onto its own row", () => {
    const narrow = media("max-width:360px").find((block) => block.includes(".header-actions{gap:6px}"))!;
    expect(narrow).toContain("header>.header-services{padding:2px 7px;font-size:12px}");
    expect(narrow).not.toContain("header>div:first-child{flex:1 1 100%}");
    expect(styles).not.toContain("header>div:first-child{flex:1 1 100%}");
  });

  it("the history table has one paginator", () => {
    const history = slice('<div class="panel-head history-head">', "+(allowed(\"payments.view\")&&data.invoices.length");
    expect(history.match(/class="history-more history-pager"/gu)?.length).toBe(1);
    expect(history).not.toContain('<div class="history-pager">');
    expect(history).toContain('data-testid="history-paginator"');
    expect(history.indexOf('data-testid="history-page"')).toBeGreaterThan(history.indexOf("appointmentTable(historyRows"));
    expect(history).toContain('data-testid="history-shown"');
    expect(history).toContain("history-view-all");
  });
});
