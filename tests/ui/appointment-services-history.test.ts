import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE WORK LIST, THE LINE EDITOR AND THE APPOINTMENT HISTORY, RUN OUT OF `public/app.js`.
 *
 * Three things this surface now promises, each held here against the real markup functions
 * rather than a paraphrase of them:
 *
 *   THE WORK LIST states each booked service as it stands for THIS visit - `$price · N min` - and
 *       marks a line whose figures were set by hand, quoting what the catalog would have said. Its
 *       pencil follows the two halves every control on the surface follows: absent where the route
 *       would refuse the write, disabled with the key named where the role may not make it.
 *
 *   THE EDITOR offers the price as a FIELD only to a role holding
 *       `appointments.service_price_edit`; to anyone else it is text with a one-line reason, and
 *       the request they send carries no `priceMinor` at all. Adding a service through the catalog
 *       sends `lines` with every existing id, so an edited line survives the change.
 *
 *   THE HISTORY is collapsed, counted from the server, newest first, and never prints an id or a
 *       note's text. Each kind of entry has its own reading.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `service.resolutionSource==="manual"` → `true`
 *       "a catalog-priced line carries no mark" fails.
 *
 *   `mayPrice ? field(...) : readonly` → always the field
 *       "the price is text, with the key named, without the permission" fails.
 *
 *   `if(mayPrice&&form.has("price"))` dropped
 *       "a groomer's save never carries a price" fails.
 *
 *   `kept.map(service=>({id:service.id,...}))` → `({serviceId})`
 *       "adding a service keeps every existing line's id" fails.
 *
 *   `entry.reason` → `entry.after?.notes` or any note field
 *       "a note edit says that a note changed and nothing of what it says" fails.
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/** The history: its vocabulary, the entry reader, the lifecycle derivation and the list. */
const HISTORY = slice(
  "const APPOINTMENT_ACTIVITY_LABELS={",
  "\n// ---------------------------------------------------------------------------\n// The appointment surface stack"
);
/** The note block, the refusal attributes, the work list and the surface that draws them. */
const NOTES = slice(
  "function appointmentRecordNoteMarkup(surface){",
  "\nfunction appointmentPermissionRefusal("
);
const SURFACE = slice(
  "function appointmentPermissionRefusal(action){",
  "\n/**\n * The appointment detail surface: level 1 of the stack."
);
/** The three permission-copy helpers every refusal builder goes through. */
const REFUSAL_COPY = slice("const SERVER_PERMISSION_REFUSAL=", "\nfunction settleUnauthenticated() {");
const DERIVE = slice("  const derive=()=>{", "\n  /**\n   * The appointment note redraws");
const OUTSTANDING = slice(
  "const OUTSTANDING_INVOICE_STATUSES=",
  "\n// Minutes as an operator says them."
);
/** The two dialogs and the write behind them. */
const EDITORS = slice("function serviceListMutation(", "\nfunction moveAppointment(");
/** The shared field helper, run rather than restated. */
const FIELD = slice(
  "function field(name, label, type = \"text\", extra = \"\", wide = false) {",
  "\n// ── Pet type and breed taxonomy"
);

const escape = (value = "") =>
  String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttr = (value = "") => escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const money = (minor: unknown) => "$" + (Number(minor || 0) / 100).toFixed(2);

// ─── THE HISTORY ─────────────────────────────────────────────────────────────────────────────

interface Entry { what: string; details: string[]; who: string; when: string; reason: string }
interface History {
  line(entry: Record<string, unknown>): Entry;
  markup(state: Record<string, unknown>): string;
  count(state: Record<string, unknown>): string;
}

function history(): History {
  const scope: Record<string, unknown> = {
    escape, escapeAttr, money,
    // The preference layer, stubbed to something a test can read back.
    formatPrefDateAndTime: (when: Date) => `@${when.toISOString().slice(0, 16).replace("T", " ")}`
  };
  const names = Object.keys(scope);
  const countLabel = slice("function appointmentActivityCountLabel(state){", "\n/**\n * THE WORK LIST");
  const factory = new Function(
    ...names,
    [HISTORY, countLabel, "return { line: appointmentActivityLine, markup: appointmentActivityMarkup, count: appointmentActivityCountLabel };"].join("\n")
  ) as (...args: unknown[]) => History;
  return factory(...names.map((name) => scope[name]));
}

const staff = { label: "Morgan", kind: "staff" };
const T1 = "2026-09-17T16:00:00.000Z";
const T2 = "2026-09-17T17:00:00.000Z";
const base = {
  id: "0d9c2ac5-0000-4000-8000-00000000aaaa", at: T1, actor: staff, reason: null,
  fromStatus: null, toStatus: null, fromStartAt: null, toStartAt: null, fromEndAt: null, toEndAt: null,
  fromGroomer: null, toGroomer: null, lines: null, line: null, amountMinor: null, method: null,
  totalMinor: null, relatedAppointmentId: null, relatedAppointmentStartAt: null
};

describe("the Appointment History reads each kind of entry for a person", () => {
  const feed = history();

  it("reads a lifecycle transition by the operator's word for it", () => {
    expect(feed.line({ ...base, action: "appointment.create" }).what).toBe("Created");
    expect(feed.line({ ...base, action: "appointment.checked_in" }).what).toBe("Checked in");
    expect(feed.line({ ...base, action: "appointment.completed" }).what).toBe("Ready for pickup");
    expect(feed.line({ ...base, action: "appointment.cancelled" }).what).toBe("Cancelled");
    expect(feed.line({ ...base, action: "appointment.no_show" }).what).toBe("No-show");
  });

  it("names who and when on every entry, from the actor the server attributed", () => {
    const entry = feed.line({ ...base, action: "appointment.checked_in" });
    expect(entry.who).toBe("Morgan");
    expect(entry.when).toBe("@2026-09-17 16:00");
    expect(feed.line({ ...base, action: "appointment.checked_in", actor: { label: "System", kind: "system" } }).who)
      .toBe("System");
  });

  it("reads a reschedule as from → to, and a groomer change by both names", () => {
    const moved = feed.line({ ...base, action: "appointment.move", fromStartAt: T1, toStartAt: T2 });
    expect(moved.what).toBe("Rescheduled");
    expect(moved.details).toEqual(["@2026-09-17 16:00 → @2026-09-17 17:00"]);
    const regroomed = feed.line({ ...base, action: "appointment.move", fromStartAt: T1, toStartAt: T1, fromGroomer: "Grace", toGroomer: "Gabriel" });
    expect(regroomed.what).toBe("Groomer changed");
    expect(regroomed.details).toEqual(["Grace → Gabriel"]);
    // A row written before the payload could say more: the bare label, no guess.
    expect(feed.line({ ...base, action: "appointment.move" })).toMatchObject({ what: "Moved", details: [] });
  });

  it("reads a duration edit as `60 → 75 min` and a price edit as money → money, on the line's name", () => {
    const duration = feed.line({ ...base, action: "appointment.service.duration_edit",
      line: { name: "Full Groom", fromDurationMinutes: 60, toDurationMinutes: 75, fromPriceMinor: null, toPriceMinor: null } });
    expect(duration.what).toBe("Duration changed");
    expect(duration.details).toEqual(["Full Groom: 60 → 75 min"]);
    const price = feed.line({ ...base, action: "appointment.service.price_edit",
      line: { name: "Full Groom", fromDurationMinutes: null, toDurationMinutes: null, fromPriceMinor: 8000, toPriceMinor: 9000 } });
    expect(price.what).toBe("Price changed");
    expect(price.details).toEqual(["Full Groom: $80.00 → $90.00"]);
  });

  it("diffs a services change into Added and Removed by line, and says only `Services changed` for a lossy row", () => {
    const diffed = feed.line({ ...base, action: "appointment.services.update", lines: {
      before: [{ id: "l1", serviceId: "s1", name: "Full Groom", durationMinutes: 90, priceMinor: 8500, linePosition: 1 },
        { id: "l2", serviceId: "s2", name: "Nail Trim", durationMinutes: 30, priceMinor: 2000, linePosition: 2 }],
      after: [{ id: "l1", serviceId: "s1", name: "Full Groom", durationMinutes: 90, priceMinor: 8500, linePosition: 1 },
        { id: "l3", serviceId: "s3", name: "De-shedding", durationMinutes: 45, priceMinor: 4000, linePosition: 2 }]
    } });
    expect(diffed.what).toBe("Services changed");
    expect(diffed.details).toEqual(["Added De-shedding", "Removed Nail Trim"]);
    const lossy = feed.line({ ...base, action: "appointment.services.update", lines: { before: null, after: null } });
    expect(lossy).toMatchObject({ what: "Services changed", details: [] });
  });

  it("says a note changed and nothing of what it says", () => {
    const record = feed.line({ ...base, action: "appointment.notes_edit",
      // A payload that carried the text anyway must not reach the screen.
      before: { notes: "SECRET BEFORE" }, after: { notes: "SECRET AFTER" } } as Record<string, unknown>);
    expect(record.what).toBe("Appointment note updated");
    expect(record.details).toEqual([]);
    expect(JSON.stringify(record)).not.toMatch(/SECRET/u);
    expect(feed.line({ ...base, action: "appointment.operational_notes_edit" }).what).toBe("Service note updated");
  });

  it("reads the reschedule pair by the other visit's time, never by its id", () => {
    const related = "7e1c5d3b-0000-4000-8000-00000000bbbb";
    const from = feed.line({ ...base, action: "appointment.rescheduled_from", relatedAppointmentId: related, relatedAppointmentStartAt: T2 });
    expect(from.what).toBe("Rescheduled from @2026-09-17 17:00");
    const as = feed.line({ ...base, action: "appointment.rescheduled_as", relatedAppointmentId: related, relatedAppointmentStartAt: T2 });
    expect(as.what).toBe("Rescheduled as @2026-09-17 17:00");
    expect(JSON.stringify([from, as])).not.toContain(related.slice(0, 8));
    // Without the time the pair still reads as lineage, and still without the id.
    const bare = feed.line({ ...base, action: "appointment.rescheduled_from", relatedAppointmentId: related });
    expect(bare.what).toBe("Rescheduled from a cancelled appointment");
    expect(JSON.stringify(bare)).not.toContain(related.slice(0, 8));
  });

  it("draws money only when the server sent it", () => {
    const withheld = feed.line({ ...base, action: "payment.record" });
    expect(withheld.details).toEqual([]);
    expect(feed.line({ ...base, action: "payment.record", amountMinor: 4250, method: "cash" }).details).toEqual(["$42.50 by cash"]);
    expect(feed.line({ ...base, action: "invoice.create", totalMinor: 9200 }).details).toEqual(["$92.00"]);
    expect(feed.line({ ...base, action: "payment.refund.completed", amountMinor: 1000 })).toMatchObject({ what: "Refund completed", details: ["$10.00"] });
  });

  it("lists newest first, as a compact list, with no id anywhere in it", () => {
    const older = { ...base, id: "aaaaaaaa-0000-4000-8000-000000000001", action: "appointment.create", at: T1 };
    const newer = { ...base, id: "bbbbbbbb-0000-4000-8000-000000000002", action: "appointment.checked_in", at: T2 };
    const markup = feed.markup({ items: [older, newer], failed: false });
    expect(markup.indexOf("Checked in")).toBeLessThan(markup.indexOf("Created"));
    expect(markup).toMatch(/<ol class="activity-feed">/u);
    expect(markup).not.toContain("aaaaaaaa");
    expect(markup).not.toContain("bbbbbbbb");
    expect(markup).toContain('<span class="activity-who">Morgan</span>');
  });

  it("counts from the server, and says so while loading or when it failed", () => {
    expect(feed.count({ items: [base], count: 37, failed: false })).toBe("(37)");
    expect(feed.count({ items: [base, base], count: null, failed: false })).toBe("(2)");
    expect(feed.count({ items: null, count: null, failed: false })).toBe("…");
    expect(feed.count({ items: null, count: null, failed: true })).toBe("unavailable");
  });
});

// ─── THE WORK LIST ───────────────────────────────────────────────────────────────────────────

interface Surface {
  item: Record<string, unknown>;
  permissions: Record<string, boolean> | null;
}
interface WorkList {
  grant(...permissions: string[]): void;
  derive(): Record<string, boolean>;
  appointmentSurfaceMarkup(surface: Surface): string;
  surface: Surface;
}

function lines() {
  return [
    { id: "l1", serviceId: "s1", name: "Full Groom", durationMinutes: 75, priceMinor: 9000, linePosition: 1, resolutionSource: "manual" },
    { id: "l2", serviceId: "s2", name: "Nail Trim", durationMinutes: 30, priceMinor: 2000, linePosition: 2, resolutionSource: "base" }
  ];
}

function workList(status = "scheduled", extra: Record<string, unknown> = {}): WorkList {
  const item = {
    id: "3f0f0fd3-0000-4000-8000-000000000001",
    customerId: "5c4d3b2a-0000-4000-8000-000000000002",
    petId: "9a8b7c6d-0000-4000-8000-000000000003",
    status, version: 4, notes: null, operationalNotes: null,
    invoiceId: null, invoiceStatus: null, invoiceBalanceMinor: 0,
    services: lines(), groomers: [{ id: "e1", displayName: "Alex" }],
    ...extra
  };
  const prelude = `
    "use strict";
    const petName = (record) => record.petName || "Pet";
    const granted = new Set();
    const allowed = (permission) => granted.has(permission);
    const grant = (...permissions) => { permissions.forEach((one) => granted.add(one)); };
    const appointmentsLocked = () => false;
    const appointmentMoveAllowed = () => allowed("appointments.edit");
    const appointmentBillingChip = () => ({ tone: "neutral", label: "Unbilled" });
    const appointmentLockNoteMarkup = () => "";
    const appointmentActivityMarkup = () => "<!--activity-->";
    const appointmentLifecycleMarkup = () => "<!--lifecycle-->";
    const appointmentPhotosMarkup = () => "<!--photos-->";
    const appointmentReportCardsMarkup = () => "<!--report-cards-->";
    const appointmentPresentation = (record) => ({
      status: record.status, dateLabel: "Wed, Oct 7", timeRange: "9:00 AM – 10:45 AM",
      durationMinutes: 105, totalPriceMinor: 11000, groomer: "Alex", petName: "Rex",
      breed: "Poodle", customerName: "Sam Reyes", rabiesNeeded: false, warning: null,
      serviceSnapshots: record.services
    });
    const surface = {
      item: ${JSON.stringify(item)},
      model: appointmentPresentation(${JSON.stringify(item)}),
      activity: { items: [], count: 0, failed: false }, photos: { data: null, failed: false },
      cards: { data: null, failed: false },
      client: { loaded: false, failed: false, refused: false },
      note: { open: false, draft: null, baseVersion: null, conflict: null, error: null, saving: false },
      serviceNote: { open: false, draft: null, baseVersion: null, conflict: null, error: null, saving: false },
      permissions: null
    };
    const HISTORY_INITIAL_ROWS = 10;
  `;
  const scope: Record<string, unknown> = {
    escape, escapeAttr, money,
    state: {
      me: { employeeId: "e1" }, clientProfile: null, pets: [],
      // The catalog the work list quotes back for an edited line.
      services: [
        { id: "s1", name: "Full Groom", basePriceMinor: 8000, baseDurationMinutes: 60, pricingMode: "FIXED", active: true },
        { id: "s2", name: "Nail Trim", basePriceMinor: 2000, baseDurationMinutes: 30, pricingMode: "FIXED", active: true }
      ]
    }
  };
  const names = Object.keys(scope);
  const exported = `
    surface.permissions = derive();
    return { grant, derive, appointmentSurfaceMarkup, surface };`;
  const factory = new Function(
    ...names, [prelude, REFUSAL_COPY, OUTSTANDING, NOTES, SURFACE, DERIVE, exported].join("\n")
  ) as (...args: unknown[]) => WorkList;
  return factory(...names.map((name) => scope[name]));
}

function draw(app: WorkList): string {
  app.surface.permissions = app.derive();
  return app.appointmentSurfaceMarkup(app.surface);
}

/** One work-list row's markup, by line id. */
function row(markup: string, lineId: string): string {
  const match = new RegExp(`<div class="appointment-service-row[^"]*" data-testid="appointment-service-row" data-line-id="${lineId}">[\\s\\S]*?</div>`, "u").exec(markup);
  if (!match) throw new Error(`no row for ${lineId}`);
  return match[0];
}

function control(markup: string, testid: string, lineId?: string): string | null {
  const scope = lineId ? row(markup, lineId) : markup;
  return new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`, "u").exec(scope)?.[0] ?? null;
}

describe("the work list states each service as it stands for this visit", () => {
  it("draws `$price · N min` per line and a pencil per line, with + Add service at the head", () => {
    const app = workList();
    app.grant("appointments.edit");
    const markup = draw(app);
    expect(row(markup, "l1")).toContain("$90.00 · 75 min");
    expect(row(markup, "l2")).toContain("$20.00 · 30 min");
    expect(control(markup, "appointment-service-edit", "l1")).toMatch(/aria-label="Edit Full Groom"/u);
    expect(control(markup, "appointment-service-edit", "l1")).not.toContain("disabled");
    expect(control(markup, "appointment-adjust-services")).not.toBeNull();
    expect(markup).toContain("+ Add service");
    // No permanently editable input on any row.
    expect(row(markup, "l1")).not.toMatch(/<input/u);
    expect(row(markup, "l2")).not.toMatch(/<input/u);
  });

  it("marks a hand-set line and quotes the catalog beneath it; a catalog-priced line carries no mark", () => {
    const app = workList();
    app.grant("appointments.edit");
    const markup = draw(app);
    expect(row(markup, "l1")).toContain('data-testid="appointment-service-edited"');
    expect(row(markup, "l1")).toContain("Catalog: $80.00 · 60 min");
    expect(row(markup, "l2")).not.toContain("appointment-service-edited");
    expect(row(markup, "l2")).not.toContain("Catalog:");
  });

  it("disables the pencil and Add, saying why, for a role without appointments.edit", () => {
    const app = workList();
    const markup = draw(app);
    for (const opening of [control(markup, "appointment-service-edit", "l1"), control(markup, "appointment-adjust-services")]) {
      expect(opening).toContain('disabled aria-disabled="true"');
      expect(opening).toContain("You do not have permission to change the services on this appointment");
      expect(opening).not.toMatch(/appointments\.edit/u);
    }
  });

  it("disables the pencil, saying whose visit it is, on a colleague's visit", () => {
    const app = workList("scheduled", { groomers: [{ id: "e9", displayName: "Someone else" }], employeeId: "e9" });
    app.grant("appointments.edit");
    const opening = control(draw(app), "appointment-service-edit", "l1");
    expect(opening).toContain("disabled");
    expect(opening).toContain("This appointment is assigned to another groomer");
    expect(opening).not.toMatch(/edit_all_staff/u);
  });

  it("withholds the pencil - absent, not disabled - once the route would refuse the write", () => {
    for (const status of ["completed", "cancelled", "no_show"]) {
      const app = workList(status);
      app.grant("appointments.edit");
      const markup = draw(app);
      expect(control(markup, "appointment-service-edit", "l1"), status).toBeNull();
      expect(control(markup, "appointment-adjust-services"), status).toBeNull();
    }
    const billed = workList("checked_in", { invoiceId: "inv-1", invoiceStatus: "open" });
    billed.grant("appointments.edit");
    expect(control(draw(billed), "appointment-service-edit", "l1")).toBeNull();
  });
});

// ─── THE EDITOR ──────────────────────────────────────────────────────────────────────────────

interface Modal { title: string; fields: string; submit: (form: FormLike) => Promise<unknown> | null }
interface FormLike { get(name: string): string | null; has(name: string): boolean; getAll(name: string): string[] }
interface Editors {
  edit(line: Record<string, unknown>): Modal;
  adjust(): Modal;
  requests: Array<{ path: string; method: string; body: Record<string, unknown> }>;
}

function editors(...permissions: string[]): Editors {
  const requests: Editors["requests"] = [];
  const box: { opened: Modal | null } = { opened: null };
  const appointment = {
    id: "3f0f0fd3-0000-4000-8000-000000000001", version: 4, status: "scheduled",
    startAt: "2026-09-21T16:00:00.000Z", schedulingTimezone: "America/Los_Angeles",
    services: lines(), groomers: [{ id: "e1", displayName: "Alex" }], employeeName: "Alex"
  };
  const scope: Record<string, unknown> = {
    escape, escapeAttr, money,
    allowed: (permission: string) => permissions.includes(permission),
    api: (path: string, init: { method: string; body: string }) => {
      requests.push({ path, method: init.method, body: JSON.parse(init.body) as Record<string, unknown> });
      return Promise.resolve({});
    },
    openModal: (title: string, fields: string, submit: Modal["submit"]) => { box.opened = { title, fields, submit }; },
    toast: () => undefined,
    calendarAppointmentById: () => appointment,
    appointmentLocalValue: () => "2026-09-21T09:00",
    petContextMarkup: () => "<!--pet-->",
    bookingServiceCheckboxes: () => "<!--catalog-->",
    state: { employees: [] },
    box
  };
  const names = Object.keys(scope);
  const factory = new Function(
    ...names,
    [FIELD, EDITORS, `return {
      edit: (line) => { editAppointmentServiceLine("${appointment.id}", line, null); return box.opened; },
      adjust: () => { adjustServices("${appointment.id}", null); return box.opened; }
    };`].join("\n")
  ) as (...args: unknown[]) => Omit<Editors, "requests">;
  return { ...factory(...names.map((name) => scope[name])), requests };
}

function form(values: Record<string, string | string[]>): FormLike {
  return {
    get: (name) => { const value = values[name]; return value === undefined ? null : Array.isArray(value) ? value[0] ?? null : value; },
    has: (name) => values[name] !== undefined,
    getAll: (name) => { const value = values[name]; return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
  };
}

describe("the Edit service dialog", () => {
  const line = lines()[0]!;

  it("offers the price as a field to a role holding appointments.service_price_edit", () => {
    const modal = editors("appointments.edit", "appointments.service_price_edit").edit(line);
    expect(modal.title).toBe("Edit service");
    expect(modal.fields).toContain("Full Groom");
    expect(modal.fields).toMatch(/<input[^>]*name="price"[^>]*value="90\.00"/u);
    expect(modal.fields).toMatch(/<input[^>]*name="durationMinutes"[^>]*value="75"/u);
    expect(modal.fields).not.toContain("service-line-price-readonly");
  });

  it("draws the price as text, with the reason named, without the permission - never a disabled input", () => {
    const modal = editors("appointments.edit").edit(line);
    expect(modal.fields).toContain('data-testid="service-line-price-readonly"');
    expect(modal.fields).toContain("$90.00");
    expect(modal.fields).toContain("Price changes need Edit service prices.");
    expect(modal.fields).not.toContain("service_price_edit");
    expect(modal.fields).not.toMatch(/<input[^>]*name="price"/u);
    expect(modal.fields).not.toMatch(/<input[^>]*disabled/u);
    // The duration is still theirs to change.
    expect(modal.fields).toMatch(/<input[^>]*name="durationMinutes"/u);
  });

  it("a groomer's save carries the duration and never a price", async () => {
    const app = editors("appointments.edit");
    const modal = app.edit(line);
    await modal.submit(form({ durationMinutes: "90" }));
    expect(app.requests).toEqual([{
      path: `/api/appointments/3f0f0fd3-0000-4000-8000-000000000001/services/l1`, method: "PATCH",
      body: { version: 4, durationMinutes: 90 }
    }]);
    expect(Object.keys(app.requests[0]!.body)).not.toContain("priceMinor");
  });

  it("a manager's save carries only what changed, in minor units", async () => {
    const app = editors("appointments.edit", "appointments.service_price_edit");
    await app.edit(line).submit(form({ durationMinutes: "75", price: "95.50" }));
    expect(app.requests[0]!.body).toEqual({ version: 4, priceMinor: 9550 });
    await app.edit(line).submit(form({ durationMinutes: "60", price: "90.00" }));
    expect(app.requests[1]!.body).toEqual({ version: 4, durationMinutes: 60 });
  });

  it("a save that changed nothing sends nothing", async () => {
    const app = editors("appointments.edit", "appointments.service_price_edit");
    const outcome = await app.edit(line).submit(form({ durationMinutes: "75", price: "90.00" }));
    expect(outcome).toBeNull();
    expect(app.requests).toEqual([]);
  });
});

describe("adding a service through the catalog", () => {
  it("keeps every existing line's id, so an edited line survives, and drops what was unticked", async () => {
    const app = editors("appointments.edit");
    const modal = app.adjust();
    expect(modal.title).toBe("Adjust appointment services");
    await modal.submit(form({ serviceIds: ["s1", "s3"] }));
    expect(app.requests).toEqual([{
      path: `/api/appointments/3f0f0fd3-0000-4000-8000-000000000001/services`, method: "PUT",
      body: { version: 4, lines: [{ id: "l1", serviceId: "s1" }, { serviceId: "s3" }] }
    }]);
    // The legacy shape re-resolves every line and would put a hand-priced one back on the catalog.
    expect(app.requests[0]!.body).not.toHaveProperty("serviceIds");
  });
});
