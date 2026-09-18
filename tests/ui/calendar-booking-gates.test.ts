import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE CALENDAR MUST NOT OFFER A GESTURE THAT CANNOT WORK.
 *
 * The toolbar gated `+ Add booking` and `Block time` from the day they were drawn. The GRID never
 * did. Every empty half-hour was a button announced as "create appointment"; pressing one opened
 * `#slot-menu` — static markup in `index.html`, with no gate of any kind — offering a groomer an
 * enabled `⊕ Add` and an enabled `⊘ Block`. The menu is `position:fixed` and clamped to the
 * viewport, so that `⊕` is the stray floating "+" the salon owner reported: a plus sign detached
 * from anything, in a role that cannot book.
 *
 * Pressing Add was worse than useless. `openBookingDialog` prefetches four reads before it shows
 * anything, `GET /api/customers` is `customers.view`-gated, and the rejection escaped: the
 * listener is not async, does not await, carries no `.catch`, and there is no
 * `unhandledrejection` handler anywhere in the client. The operator got a 403 in a console they
 * will never open, no dialog, no toast, and no explanation.
 *
 * Both halves are asserted here by RUNNING the client's own functions: the attributes the grid
 * writes, the menu as it stands the instant it opens, and `openBookingDialog` itself against a
 * recording `api`.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `calendarBookingAvailable()` → `allowed("appointments.create")`
 *       the read permissions stop counting, so a role that can create but cannot see clients is
 *       offered a dialog whose first act is refused. "a role that may book but may not read
 *       clients is not offered the slot" fails.
 *
 *   `calendarSlotAttributes`'s `actionable` → `open`
 *       the defect, restored. Every "a groomer is offered no…" assertion fails, including the
 *       spoken one.
 *
 *   dropping the `if(refusal)` guard in `openBookingDialog`
 *       the four reads go out and the rejection escapes again. "nothing is requested" and
 *       "the refusal is stated" both fail.
 *
 *   `catch` → rethrow in `openBookingDialog`
 *       "a prefetch that fails says so instead of rejecting" fails.
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

/** The three predicates, the two refusal sentences, and the attributes a slot is drawn with. */
const GATES = slice(
  "function calendarBookingAvailable(){",
  "\n// Drag is a fine-pointer affordance on top of that."
);
/** The three permission-copy helpers every refusal builder goes through. */
const REFUSAL_COPY = slice("const SERVER_PERMISSION_REFUSAL=", "\nfunction settleUnauthenticated() {");
/** The menu's gate, applied on every open rather than once at sign-in. */
const MENU = slice("function syncSlotMenuAvailability() {", "\nfunction openSlotMenu(slot) {");
/** The dialog's own two guards. */
const BOOKING = slice("function openBookingDialog(options={}) {", "\nconst actions = {");
/** The real de-duplicator, so a second press is a second press. */
const RUN_ONCE = slice("async function runOnce(key, operation) {", "\nasync function financialMutation(");

/** A menu item as `index.html` declares it, with only what the sync touches. */
interface MenuItem {
  disabled: boolean;
  attributes: Record<string, string>;
  title?: string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface SlotAttributes { label: string; hooks: string }

interface Client {
  calendarBookingAvailable(): boolean;
  calendarBlockingAvailable(): boolean;
  calendarSlotActionable(): boolean;
  calendarSlotAttributes(open: boolean, preset: string, groomerId: string): SlotAttributes;
  bookingRefusalReason(): string | null;
  blockingRefusalReason(): string | null;
  syncSlotMenuAvailability(): void;
  openBookingDialog(options?: Record<string, unknown>): Promise<void>;
  items: Record<"add" | "block", MenuItem>;
  /** Every path `openBookingDialog` asked the server for. */
  reads: string[];
  toasts: string[];
  /** How many times the booking workspace was actually shown. */
  shown: { count: number };
}

/** The permission preset a session is holding, plus what the server does to the prefetch. */
function client(
  granted: string[],
  { prefetch = "ok" }: { prefetch?: "ok" | "forbidden" | "offline" } = {}
): Client {
  const reads: string[] = [];
  const toasts: string[] = [];
  const shown = { count: 0 };

  const item = (): MenuItem => ({
    disabled: false,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; delete (this as { title?: string }).title; }
  });
  const items = { add: item(), block: item() };
  const menu = {
    querySelector(selector: string): MenuItem | null {
      if (selector === '[data-slot-action="add"]') return items.add;
      if (selector === '[data-slot-action="block"]') return items.block;
      throw new Error(`the fake slot menu was asked for ${selector}, which it does not model`);
    }
  };

  const api = (path: string): Promise<unknown> => {
    reads.push(path);
    if (prefetch === "forbidden") {
      const error = Object.assign(new Error("Missing permission: customers.view"), { status: 403 });
      return Promise.reject(error);
    }
    if (prefetch === "offline") return Promise.reject(new Error("Failed to fetch"));
    return Promise.resolve([]);
  };

  const state = { booking: null as unknown, customers: [], pets: [], employees: [], services: [] };
  const scope: Record<string, unknown> = {
    state, api,
    allowed: (permission: string) => granted.includes(permission),
    pendingActions: new Set(),
    toast: (message: string) => { toasts.push(message); },
    $: (selector: string) => {
      if (selector === "#slot-menu") return menu;
      if (selector === "#booking-error") return { textContent: "" };
      if (selector === "#booking-title") return { textContent: "" };
      throw new Error(`the fake document was asked for ${selector}, which it does not model`);
    },
    // Rescheduling hands the dialog a carry-over to resolve against the catalog; none of these
    // openings is one, so the resolver answers "not a reschedule".
    resolveRescheduleCarryOver: () => null,
    bookingScope: () => ({ showModal() { shown.count += 1; } }),
    bq: () => null,
    resetBookingState: () => {},
    renderBookingClientPane: () => {}, renderBookingDetailPane: () => {},
    selectBookingClient: () => Promise.resolve(),
    applyBookingPet: () => Promise.resolve(),
    bookingClientPets: () => []
  };

  const names = Object.keys(scope);
  const exported = `return {calendarBookingAvailable,calendarBlockingAvailable,calendarSlotActionable,
    calendarSlotAttributes,bookingRefusalReason,blockingRefusalReason,syncSlotMenuAvailability,
    openBookingDialog};`;
  const factory = new Function(
    ...names, [REFUSAL_COPY, RUN_ONCE, GATES, MENU, BOOKING, exported].join("\n")
  ) as (...args: unknown[]) => Omit<Client, "items" | "reads" | "toasts" | "shown">;

  return { ...factory(...names.map((name) => scope[name])), items, reads, toasts, shown };
}

/** The presets, by the keys `packages/domain/src/permissions.ts` gives them. */
const GROOMER = [
  "calendar.view", "appointments.view", "pets.view", "pets.care.view",
  "operations.check_in", "operations.perform_service", "operations.complete"
];
const RECEPTIONIST = [
  "calendar.view", "appointments.view", "appointments.create", "appointments.edit",
  "appointments.cancel", "calendar.blocks_create", "calendar.blocks_edit",
  "customers.view", "customers.edit", "pets.view", "pets.edit", "pets.care.view",
  "operations.check_in", "checkout.perform", "payments.view"
];

const SLOT = "2026-10-07T09:00";
const GROOMER_ID = "8f1c2ade-0000-4000-8000-000000000001";

describe("an empty slot is a control only for a session that can act on it", () => {
  it("a groomer is offered no slot to press, and is told about none", () => {
    const app = client(GROOMER);
    const slot = app.calendarSlotAttributes(true, SLOT, GROOMER_ID);

    // No `data-slot`, so `bindCalendarInteractions` binds no menu to it and `openSlotMenu` is
    // unreachable — which is what takes the floating "+" off the screen.
    expect(slot.hooks).toBe("disabled");
    expect(slot.hooks).not.toContain("data-slot");
    // And the accessible name stops promising a booking. A screen reader announcing "create
    // appointment" over a cell that creates nothing is the same defect, spoken.
    expect(slot.label).toBe("");
  });

  it("a receptionist gets the slot, its preset and its groomer", () => {
    const app = client(RECEPTIONIST);
    const slot = app.calendarSlotAttributes(true, SLOT, GROOMER_ID);

    expect(slot.hooks).toBe(`data-slot="${SLOT}" data-slot-groomer="${GROOMER_ID}"`);
    expect(slot.label).toBe(", create appointment");
  });

  it("a slot outside business hours stays closed for everyone", () => {
    for (const preset of [GROOMER, RECEPTIONIST]) {
      const slot = client(preset).calendarSlotAttributes(false, SLOT, GROOMER_ID);
      expect(slot.hooks).toBe("disabled");
      expect(slot.label).toBe(", closed");
    }
  });

  it("a role that may only block still gets the slot — one of the two is enough", () => {
    const app = client(["calendar.view", "appointments.view", "calendar.blocks_create"]);
    expect(app.calendarBookingAvailable()).toBe(false);
    expect(app.calendarSlotActionable()).toBe(true);
    expect(app.calendarSlotAttributes(true, SLOT, GROOMER_ID).hooks).toContain("data-slot");
  });

  it("a role that may book but may not read clients is not offered the slot", () => {
    // `openBookingDialog` cannot draw a client list it is refused, so the write permission alone
    // is not the capability. This is the case a gate on `appointments.create` alone gets wrong.
    const app = client(["calendar.view", "appointments.view", "appointments.create", "pets.view"]);
    expect(app.calendarBookingAvailable()).toBe(false);
    expect(app.calendarSlotActionable()).toBe(false);
    expect(app.bookingRefusalReason()).toBe("You do not have permission to book appointments");
  });
});

describe("the slot menu says which of its two items this session may use", () => {
  it("offers a groomer neither, and says why on each", () => {
    const app = client(GROOMER);
    app.syncSlotMenuAvailability();

    expect(app.items.add.disabled).toBe(true);
    expect(app.items.add.attributes["aria-disabled"]).toBe("true");
    expect(app.items.add.title).toBe("You do not have permission to book appointments");

    expect(app.items.block.disabled).toBe(true);
    expect(app.items.block.title).toBe("You do not have permission to block time");
  });

  it("offers a receptionist both, with nothing to explain", () => {
    const app = client(RECEPTIONIST);
    app.syncSlotMenuAvailability();

    expect(app.items.add.disabled).toBe(false);
    expect(app.items.add.attributes["aria-disabled"]).toBe("false");
    expect(app.items.add.title).toBeUndefined();
    expect(app.items.block.disabled).toBe(false);
    expect(app.items.block.title).toBeUndefined();
  });

  it("re-syncs on every open, so a permission that moved mid-session is not stale", () => {
    // The menu is static markup. Once disabled it stays disabled unless something puts it back.
    const app = client(RECEPTIONIST);
    app.items.add.disabled = true;
    app.items.add.title = "left over from a role this session no longer has";

    app.syncSlotMenuAvailability();

    expect(app.items.add.disabled).toBe(false);
    expect(app.items.add.title).toBeUndefined();
  });
});

describe("openBookingDialog fails safely wherever it is reached from", () => {
  it("without customers.view: nothing is requested, nothing is shown, and the operator is told", async () => {
    const app = client(GROOMER);

    // No rejection escapes: awaiting this is what proves it, because an unhandled rejection here
    // is exactly what left the screen blank.
    await expect(app.openBookingDialog({ preset: SLOT })).resolves.toBeUndefined();

    expect(app.reads).toEqual([]);
    expect(app.shown.count).toBe(0);
    expect(app.toasts).toHaveLength(1);
    expect(app.toasts[0]).toBe("You do not have permission to book appointments");
  });

  it("says the same thing however many keys are missing, and never names one", async () => {
    const app = client(["calendar.view", "appointments.view"]);
    await app.openBookingDialog();

    expect(app.toasts[0]).toBe("You do not have permission to book appointments");
    expect(app.toasts[0]).not.toMatch(/[a-z_]+\.[a-z_]+/u);
  });

  it("with the permissions, it prefetches and shows the workspace", async () => {
    const app = client(RECEPTIONIST);
    await app.openBookingDialog({ preset: SLOT });

    expect(app.reads).toEqual(["/api/customers", "/api/pets", "/api/employees", "/api/services"]);
    expect(app.shown.count).toBe(1);
    expect(app.toasts).toEqual([]);
  });

  it("a prefetch refused despite the gate is stated, not rejected, and shows nothing", async () => {
    // The session's permissions moved under it: the client believed it could book, the server
    // disagreed. `api()` has already re-read `/api/me` by the time this lands.
    const app = client(RECEPTIONIST, { prefetch: "forbidden" });

    await expect(app.openBookingDialog()).resolves.toBeUndefined();

    expect(app.shown.count).toBe(0);
    expect(app.toasts).toHaveLength(1);
  });

  it("a prefetch that fails on the network says so instead of rejecting", async () => {
    const app = client(RECEPTIONIST, { prefetch: "offline" });

    await expect(app.openBookingDialog()).resolves.toBeUndefined();

    expect(app.shown.count).toBe(0);
    expect(app.toasts).toEqual(["Failed to fetch"]);
  });
});
