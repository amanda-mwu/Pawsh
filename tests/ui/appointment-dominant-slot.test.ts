import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { invoiceSettledStatuses, permissionPresets } from "@pawsh/domain";

/**
 * A DISABLED CONTROL CAN NEVER HOLD THE FOOTER'S DOMINANT SLOT.
 *
 * Human QA, as a groomer, opened a checked-in visit and reported "only option is to save, no ready
 * for pick up and no take payment button seen". Ready for Pickup was drawn, enabled and working.
 * What had happened was a ranking defect: `primarySlot` ranked on `offered` alone, a groomer
 * holds no `checkout.perform` so nothing money-shaped claimed the slot, and the ranking fell
 * through to `close` - which made SAVE the primary. Save ships disabled until the note is dirty.
 * So the loudest thing on the screen was a disabled blue button, and the one enabled action stood
 * beside it in the quieter rank. The same shape put a disabled Invoice in the slot on a settled
 * visit for a role without `payments.view`.
 *
 * The rule is now `dominantAction()`: the first action in the ranking that is BOTH offered AND
 * enabled takes the slot; a refused control passes it on; and when nothing enabled remains the
 * footer draws no primary rather than promoting a refusal. This file holds that rule from every
 * side it has been seen to fail, with the real `derive()` and the real footer markup.
 *
 * Also here, because they were reported in the same pass and live in the same markup:
 *
 *   THE SERVICE NOTE IS AN EDITOR OF ITS OWN - Add / Edit on its heading OPENS it, Save and
 *       Cancel sit inside the block, and the footer carries no Save at all. The old shape - a
 *       standing field whose only commit was a sleeping footer Save a screen away - is what human
 *       QA typed into and lost.
 *   THE SERVICE NOTE'S WINDOW INCLUDES `completed`, which is where Rocky's note went missing.
 *   OWNERSHIP IS A REFUSAL OF ITS OWN - a groomer on a colleague's visit is told which key would
 *       lift it, on every scoped control.
 *   THE PENCIL IS DRAWN, NOT TYPED (A3) - an inline stroked path in currentColor, so its contrast
 *       is the button's, not the platform symbol font's.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `dominantAction` returns the first OFFERED name regardless of `enabled`
 *       "a colleague's settled visit never leads with an Invoice the groomer cannot open" and "a
 *       refused Check In does not hold the slot" fail: the refusal is promoted again.
 *   `["ready", ...]` removed from the ranking
 *       "a groomer's checked-in footer leads with Ready for Pickup" fails: nothing enabled
 *       outranks the utilities, and no primary is drawn where one is due.
 *   `["invoice", can.invoice, true]`
 *       "a colleague's settled visit never leads with an Invoice the groomer cannot open" fails.
 *   `invoiceReadable` returning `allowed("payments.view")` alone - the old rule
 *       "a groomer's OWN settled visit leads with the Invoice, enabled" fails.
 *   `INVOICE_SETTLED_STATUSES` widened to `open` or `partially_paid`
 *       "a bill that is still moving stays refused on the groomer's own visit" fails, and the
 *       tuple check against `invoiceSettledStatuses` fails.
 *   `scopeAllows` returning true unconditionally
 *       "a groomer on another groomer's visit is refused by scope, with the key named" fails.
 *   `serviceNote:{open:true,...}` as the surface's initial editor state
 *       "a held note opens in read mode, and the editor only on Edit" fails.
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

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
/** The calendar card's overflow menu, which is gated the way the surface is. */
const CARD_MENU = slice("function calendarScopeAttrs(item){", "\n// The hash fallback.");

interface Module {
  derive(): Record<string, boolean | string>;
  markup(): string;
  serviceNoteMarkup(): string;
  openServiceNote(draft: string): void;
  conflictServiceNote(saved: string | null): void;
  dominantAction(ranking: Array<[string, boolean, boolean]>): string | null;
}

const GROOMER = permissionPresets.groomer!;
const EVERYTHING = [
  ...new Set(Object.values(permissionPresets).flat())
];

/**
 * A visit in one status, seen by a role holding exactly `granted`.
 *
 * `me` is the session's own employee id. The fixture visit is assigned to `e1`, so the default
 * session OWNS it; a test about scope passes another id, or null for a session with no employee
 * record at all.
 */
function client(
  status: string, granted: readonly string[], extra: Record<string, unknown> = {},
  { me = "e1" }: { me?: string | null } = {}
): Module {
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const escapeAttr = (value = "") =>
    escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");

  const item = {
    id: "3f0f0fd3-0000-4000-8000-000000000001",
    customerId: "5c4d3b2a-0000-4000-8000-000000000002",
    petId: "9a8b7c6d-0000-4000-8000-000000000003",
    status, version: 4, notes: "Ask about the ears.", operationalNotes: null,
    invoiceId: null, invoiceStatus: null, invoiceBalanceMinor: 0,
    services: [{ serviceId: "s1", name: "Full groom", durationMinutes: 90, priceMinor: 6500 }],
    groomers: [{ id: "e1", displayName: "Alex" }],
    // The server's `servicesEditable`: an editable status and no recorded payment - an invoiced
    // fixture stands for a paid one here unless it says otherwise.
    servicesEditable: ["scheduled", "checked_in", "in_service", "completed"].includes(status) && !extra.invoiceId,
    ...extra
  };

  const prelude = `
    "use strict";
    const money = (minor) => "$" + (Number(minor || 0) / 100).toFixed(2);
    const petName = (record) => record.petName || "Pet";
    const granted = new Set(${JSON.stringify(granted)});
    const allowed = (permission) => granted.has(permission);
    const appointmentsLocked = () => false;
    const appointmentMoveAllowed = () => allowed("appointments.edit");
    const appointmentBillingChip = () => ({ tone: "neutral", label: "Unbilled" });
    const appointmentStatusLabel = (status) => String(status || "").replaceAll("_", " ");
    // The surface head reads the lifecycle through these two (tests/ui/qa-round3.test.ts holds them).
    const appointmentReadyForPickup = () => false;
    const appointmentLifecycleLabel = (item) => appointmentStatusLabel(item?.status);
    const appointmentLockNoteMarkup = () => "";
    const appointmentActivityMarkup = () => "<!--activity-->";
    const appointmentLifecycleMarkup = () => "<!--lifecycle-->";
    const appointmentPhotosMarkup = () => "<!--photos-->";
    const appointmentReportCardsMarkup = () => "<!--report-cards-->";
    const OUTSTANDING_INVOICE_STATUSES = new Set(["open", "partially_paid"]);
    const appointmentInvoiceOutstanding = (record) =>
      Boolean(record.invoiceId) && OUTSTANDING_INVOICE_STATUSES.has(record.invoiceStatus);
    const appointmentPresentation = (record) => ({
      status: record.status, dateLabel: "Wed, Oct 7", timeRange: "9:00 AM - 10:30 AM",
      durationMinutes: 90, totalPriceMinor: 6500, groomer: "Alex", petName: "Rex",
      breed: "Poodle", customerName: "Sam Reyes", rabiesNeeded: false, warning: null,
      serviceSnapshots: record.services
    });
    const surface = {
      item: ${JSON.stringify(item)},
      model: appointmentPresentation(${JSON.stringify(item)}),
      activity: { items: [], failed: false }, photos: { data: null, failed: false },
      cards: { data: null, failed: false },
      client: { loaded: false, failed: false, refused: false },
      note: { open: false, draft: null, baseVersion: null, conflict: null, error: null, saving: false },
      serviceNote: { open: false, draft: null, baseVersion: null, conflict: null, error: null, saving: false },
      permissions: null
    };
    const HISTORY_INITIAL_ROWS = 10;
  `;
  const exported = `
    return {
      derive, dominantAction,
      markup: () => { surface.permissions = derive(); return appointmentSurfaceMarkup(surface); },
      serviceNoteMarkup: () => { surface.permissions = derive(); return appointmentServiceNoteMarkup(surface); },
      openServiceNote: (draft) => { surface.serviceNote = { open: true, draft, baseVersion: 4, conflict: null, error: null, saving: false }; },
      conflictServiceNote: (saved) => { surface.serviceNote.conflict = { operationalNotes: saved }; }
    };`;
  const scope: Record<string, unknown> = {
    escape, escapeAttr, state: { me: { employeeId: me }, clientProfile: null, pets: [] }
  };
  const names = Object.keys(scope);
  const factory = new Function(
    ...names, [prelude, REFUSAL_COPY, NOTES, SURFACE, DERIVE, exported].join("\n")
  ) as (...args: unknown[]) => Module;
  return factory(...names.map((name) => scope[name]));
}

/** The opening tag of one control, or null when the footer drew none. */
function control(markup: string, testid: string): string | null {
  return new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`, "u").exec(markup)?.[0] ?? null;
}

/** Every button drawn as the primary, by test id. */
function primaries(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*class="primary [^"]*"[^>]*data-testid="([^"]+)"/gu)]
    .map((match) => match[1]!);
}

/** The controls of one footer zone, in DOM order. */
function zone(markup: string, name: "lead" | "utility"): string[] {
  const block = new RegExp(`<div class="surface-foot-actions surface-foot-${name}">(.*?)</div>`, "su")
    .exec(markup)?.[1] ?? "";
  return [...block.matchAll(/data-testid="([^"]+)"/gu)].map((match) => match[1]!);
}

const SETTLED = { invoiceId: "inv-1", invoiceStatus: "paid", invoiceBalanceMinor: 0 };
/** The visit reassigned to somebody else, so the default session (`e1`) does not own it. */
const COLLEAGUES = { employeeId: "e2", groomers: [{ id: "e2", displayName: "Sam" }] };

describe("dominantAction: the first action that is both offered and enabled", () => {
  const app = client("checked_in", EVERYTHING);

  it("passes over a disabled action to the next enabled one, whatever the rank", () => {
    expect(app.dominantAction([["a", true, false], ["b", true, true], ["c", true, true]])).toBe("b");
  });

  it("passes over an action that is not offered at all", () => {
    expect(app.dominantAction([["a", false, true], ["b", true, true]])).toBe("b");
  });

  it("gives the slot to nothing when nothing enabled is offered", () => {
    expect(app.dominantAction([["a", true, false], ["b", false, true], ["c", false, false]])).toBeNull();
    expect(app.dominantAction([])).toBeNull();
  });
});

describe("a disabled control never steals the dominant slot", () => {
  it("a groomer's checked-in footer leads with Ready for Pickup, enabled and primary", () => {
    const markup = client("checked_in", GROOMER).markup();
    const ready = control(markup, "appointment-ready");
    expect(ready).toContain('class="primary compact"');
    expect(ready).not.toContain("disabled");
    // Take Payment is correctly absent: the role holds no checkout.perform. That absence is what
    // used to hand the slot to Save.
    expect(control(markup, "appointment-take-payment")).toBeNull();
    expect(primaries(markup)).toEqual(["appointment-ready"]);
  });

  it("draws no Save in the footer at all, in any status, for any role", () => {
    for (const [status, role] of [["checked_in", GROOMER], ["in_service", GROOMER], ["completed", GROOMER], ["checked_in", EVERYTHING]] as const) {
      expect(control(client(status, role).markup(), "appointment-save"), `${status}`).toBeNull();
    }
  });

  it("the owner's checked-in footer is unchanged: the money leads, Ready is the strong secondary", () => {
    const markup = client("checked_in", EVERYTHING).markup();
    expect(primaries(markup)).toEqual(["appointment-take-payment"]);
    expect(control(markup, "appointment-ready")).toContain("secondary is-strong");
  });

  it("a colleague's settled visit never leads with an Invoice the groomer cannot open", () => {
    // Gabriel's visit, seen by Grace: she holds no payments.view and the visit is not hers, so
    // the receipt route would refuse her and the footer says so before she asks.
    const markup = client("completed", GROOMER, { ...SETTLED, ...COLLEAGUES }).markup();
    const invoice = control(markup, "appointment-invoice");
    // Still drawn, still disabled, still naming the reason - it is a document that exists.
    expect(invoice).toContain("disabled");
    expect(invoice).toContain("permission to view invoices");
    expect(invoice).not.toContain('class="primary');
    // Nothing enabled outranks it, and the sheet is never the primary (QA UX-13), so the footer
    // draws no primary rather than promoting a disabled control.
    expect(primaries(markup)).toEqual([]);
  });

  it("a groomer's OWN settled visit leads with the Invoice, enabled, with the sheet beside it", () => {
    // The receipt route answers a caller without payments.view when the invoice is settled AND
    // its appointment is assigned to them. The footer mirrors exactly that: the bill of the work
    // Grace did is hers to read once the money is closed.
    for (const invoiceStatus of invoiceSettledStatuses) {
      const markup = client("completed", GROOMER, { invoiceId: "inv-1", invoiceStatus, invoiceBalanceMinor: 0 }).markup();
      const invoice = control(markup, "appointment-invoice");
      expect(invoice, invoiceStatus).not.toContain("disabled");
      expect(invoice, invoiceStatus).toContain('class="primary compact"');
      expect(primaries(markup), invoiceStatus).toEqual(["appointment-invoice"]);
      expect(zone(markup, "lead"), invoiceStatus).toEqual(["appointment-invoice"]);
      expect(markup, invoiceStatus).toMatch(/<div class="surface-head-actions">.*?data-testid="appointment-ticket"/su);
    }
  });

  it("a bill that is still moving stays refused on the groomer's own visit", () => {
    // Open, partially paid, void: not settled, so the route refuses and so does the footer -
    // with the same title, because the key that would lift it is still payments.view.
    for (const invoiceStatus of ["open", "partially_paid", "void"]) {
      const markup = client("completed", GROOMER, { invoiceId: "inv-1", invoiceStatus, invoiceBalanceMinor: 1000 }).markup();
      const invoice = control(markup, "appointment-invoice");
      expect(invoice, invoiceStatus).toContain("disabled");
      expect(invoice, invoiceStatus).toContain("permission to view invoices");
      expect(primaries(markup), invoiceStatus).not.toContain("appointment-invoice");
    }
    // The client's list of settled statuses is the domain's, held here because app.js cannot
    // import it.
    const listed = /const INVOICE_SETTLED_STATUSES=new Set\(\[([^\]]*)\]\)/u.exec(source)?.[1] ?? "";
    expect(listed.match(/"([a-z_]+)"/gu)?.map((entry) => entry.replaceAll('"', "")).sort())
      .toEqual([...invoiceSettledStatuses].sort());
    // A session with no employee record owns no visit, so the widening never reaches it.
    expect(control(client("completed", GROOMER, SETTLED, { me: null }).markup(), "appointment-invoice")).toContain("disabled");
  });

  it("a settled visit still leads with the Invoice for a role that can open it", () => {
    const markup = client("completed", EVERYTHING, SETTLED).markup();
    expect(primaries(markup)).toEqual(["appointment-invoice"]);
  });

  it("a refused Check In does not hold the slot on a scheduled visit", () => {
    // A role with nothing but the calendar: Check In is offered, disabled with its reason, and
    // nothing else on the footer is enabled. The honest footer draws no primary at all.
    const markup = client("scheduled", ["calendar.view", "appointments.view"]).markup();
    const checkIn = control(markup, "appointment-check-in");
    expect(checkIn).toContain("disabled");
    expect(checkIn).not.toContain('class="primary');
    expect(primaries(markup)).toEqual([]);
  });

  it("no enabled lead action means no primary, not a blue disabled one", () => {
    // Checked in, seen by a role that may write the note but neither finish nor bill the visit:
    // Ready for Pickup is drawn refused - in the utility group, never the lead (QA W-1) - its
    // reason is said on screen, and nothing is promoted in its place.
    const markup = client("checked_in", ["appointments.view", "operations.perform_service"]).markup();
    expect(zone(markup, "lead")).toEqual(["appointment-refusal-note"]);
    expect(zone(markup, "utility")).toContain("appointment-ready");
    expect(control(markup, "appointment-ready")).toContain("disabled");
    expect(markup).toContain("You do not have permission to mark work as finished.</p>");
    expect(primaries(markup)).toEqual([]);
  });

  it("never puts a disabled control in the lead zone, and always says why one was refused (QA W-1)", () => {
    const leadBlock = (markup: string) =>
      /<div class="surface-foot-actions surface-foot-lead">(.*?)<\/div>/su.exec(markup)?.[1] ?? "";
    const roles = { ...permissionPresets, groomerOther: GROOMER };
    for (const [name, preset] of Object.entries(roles)) {
      for (const status of ["scheduled", "checked_in", "in_service", "completed", "cancelled", "no_show"]) {
        for (const extra of [{}, SETTLED, { invoiceId: "inv-1", invoiceStatus: "open", invoiceBalanceMinor: 1000 }]) {
          const markup = client(status, preset, name === "groomerOther" ? { ...extra, ...COLLEAGUES } : extra).markup();
          const where = `${name} ${status} ${JSON.stringify(extra)}`;
          expect(leadBlock(markup), where).not.toMatch(/<button[^>]*\sdisabled/u);
          const utility = /<div class="surface-foot-actions surface-foot-utility">(.*?)<\/div>/su.exec(markup)?.[1] ?? "";
          // The Invoice is a lead candidate only on a read-only (completed, invoiced) visit.
          const candidates = status === "completed" ? "reschedule|invoice|ready|check-in|complete" : "reschedule|ready|check-in|complete";
          const refusedLead = new RegExp(`data-testid="appointment-(${candidates})"[^>]*\\sdisabled`, "u").test(utility);
          if (refusedLead) expect(markup, where).toMatch(/data-testid="appointment-(refusal-note|view-only)"/u);
        }
      }
    }
  });

  it("a colleague's read-only visit says whose it is instead of leading with a refused control", () => {
    for (const [status, extra] of [["cancelled", {}], ["completed", SETTLED]] as const) {
      const markup = client(status, GROOMER, { ...extra, ...COLLEAGUES }).markup();
      expect(zone(markup, "lead"), status).toEqual(["appointment-view-only"]);
      expect(markup, status).toContain("Assigned to");
    }
  });

  it("draws at most one primary in every status for every preset", () => {
    for (const [name, preset] of Object.entries(permissionPresets)) {
      for (const status of ["scheduled", "checked_in", "in_service", "completed", "cancelled", "no_show"]) {
        for (const extra of [{}, SETTLED]) {
          const markup = client(status, preset, extra).markup();
          const found = primaries(markup);
          expect(found.length, `${name} ${status} ${JSON.stringify(extra)}: ${found.join(",")}`).toBeLessThanOrEqual(1);
          // And whatever holds the slot is pressable.
          for (const testid of found) expect(control(markup, testid), `${name} ${status}`).not.toContain("disabled");
        }
      }
    }
  });

  it("an in-service visit leads with Complete for the groomer who can finish it", () => {
    const markup = client("in_service", GROOMER).markup();
    expect(primaries(markup)).toEqual(["appointment-complete"]);
    expect(control(markup, "appointment-complete")).not.toContain("disabled");
  });

  it("a completed, unbilled visit draws no primary for a groomer, never a disabled one", () => {
    // No money, no invoice, no transition is enabled for this role. The sheet stays the quiet
    // utility it is in every state (QA UX-13), so nothing takes the slot and nothing disabled
    // is promoted.
    const markup = client("completed", GROOMER).markup();
    expect(primaries(markup)).toEqual([]);
    expect(markup).toMatch(/<div class="surface-head-actions">.*?data-testid="appointment-ticket"/su);
    expect(control(markup, "appointment-take-payment")).toBeNull();
    expect(control(markup, "appointment-invoice")).toBeNull();
  });

  it("a cancelled visit leads with Reschedule for a role that can book, and with nothing for one that cannot", () => {
    // The groomer preset holds no appointments.create, so Reschedule is drawn refused with its
    // reason. There is no footer Close any more (QA UX-13) - the head's x is the way out - so no
    // primary is drawn rather than a dismissal standing in for one.
    const groomer = client("cancelled", GROOMER).markup();
    expect(control(groomer, "appointment-reschedule")).toContain("disabled");
    expect(control(groomer, "appointment-reschedule")).toContain("You do not have permission to book appointments");
    expect(primaries(groomer)).toEqual([]);
    expect(control(groomer, "appointment-close")).toBeNull();
    for (const status of ["cancelled", "no_show"]) {
      const desk = client(status, EVERYTHING).markup();
      expect(control(desk, "appointment-reschedule"), status).not.toContain("disabled");
      expect(primaries(desk), status).toEqual(["appointment-reschedule"]);
      expect(zone(desk, "lead"), status).toEqual(["appointment-reschedule"]);
    }
    // And on no other status: a live visit is moved, not rescheduled from scratch.
    for (const status of ["scheduled", "checked_in", "in_service", "completed"]) {
      expect(control(client(status, EVERYTHING).markup(), "appointment-reschedule"), status).toBeNull();
    }
  });

  it("draws Print Ticket as the same utility secondary in every status (QA UX-13)", () => {
    // Still exactly one Print Ticket, still the same document, and now one look: it used to move
    // into the lead zone - and into the primary - on a completed visit.
    for (const status of ["scheduled", "checked_in", "in_service", "completed", "cancelled", "no_show"]) {
      for (const extra of [{}, SETTLED]) {
        const markup = client(status, EVERYTHING, extra).markup();
        const where = `${status} ${JSON.stringify(extra)}`;
        // The sheet is the head's printer icon (QA round 3): in neither footer zone, in every state.
        expect(markup, where).toMatch(/<div class="surface-head-actions">.*?data-testid="appointment-ticket"/su);
        expect(zone(markup, "utility"), where).not.toContain("appointment-ticket");
        expect(zone(markup, "lead"), where).not.toContain("appointment-ticket");
        expect(control(markup, "appointment-ticket"), where).toContain('aria-label="Print Ticket"');
        expect(markup.match(/data-testid="appointment-ticket"/gu), where).toHaveLength(1);
      }
    }
    expect(primaries(client("completed", EVERYTHING, SETTLED).markup())).toEqual(["appointment-invoice"]);
    expect(primaries(client("completed", EVERYTHING).markup())).toEqual(["appointment-take-payment"]);
    expect(primaries(client("completed", GROOMER).markup())).toEqual([]);
  });
});

describe("the service note is an editor of its own", () => {
  const button = (markup: string) =>
    /<button[^>]*data-testid="appointment-service-note-edit"[^>]*>([^<]*)<\/button>/u.exec(markup);

  it("offers Add on an empty note and draws no field until it is pressed", () => {
    const markup = client("checked_in", GROOMER).markup();
    const found = button(markup);
    expect(found?.[1]).toBe("Add");
    expect(found?.[0]).toContain('aria-label="Add service note"');
    expect(found?.[0]).not.toContain("disabled");
    expect(markup).not.toContain('data-testid="appointment-service-note-input"');
    expect(markup).not.toContain('data-testid="appointment-service-note-save"');
  });

  it("offers Edit once a note is held, following what the server holds", () => {
    const markup = client("in_service", GROOMER, { operationalNotes: "Matted behind both ears." }).markup();
    const found = button(markup);
    expect(found?.[1]).toBe("Edit");
    expect(found?.[0]).toContain('aria-label="Edit service note"');
    expect(markup).toContain('data-testid="appointment-service-note">Matted behind both ears.');
  });

  it("a held note opens in read mode, and the editor only on Edit", () => {
    // Human QA opened a checked-in visit that held a note, as the owner, and found the block in
    // edit mode. That is the shape the block had BEFORE it became an editor of its own - a
    // standing textarea for anybody with operations.perform_service - and this holds the line
    // against it coming back: a fresh surface draws the note as text with Edit on the heading and
    // no field, for every role that may write it, in every status the route accepts.
    const held = { operationalNotes: "Matted behind both ears." };
    for (const [status, role] of [["checked_in", EVERYTHING], ["checked_in", GROOMER], ["in_service", EVERYTHING], ["completed", EVERYTHING]] as const) {
      const app = client(status, role, held);
      const markup = app.markup();
      expect(markup, `${status}`).not.toContain('data-testid="appointment-service-note-input"');
      expect(markup, `${status}`).not.toContain('data-testid="appointment-service-note-save"');
      expect(markup, `${status}`).toContain('data-testid="appointment-service-note">Matted behind both ears.');
      expect(button(markup)?.[1], `${status}`).toBe("Edit");
      // And once Edit is pressed the field is there - the editor is reachable, just not standing.
      app.openServiceNote("Matted behind both ears.");
      expect(app.serviceNoteMarkup(), `${status}`).toContain('data-testid="appointment-service-note-input"');
    }
    // The surface's own initial editor state, as `openCalendarAppointment` seats it: shut.
    const seated = /serviceNote:\{open:(false|true),draft:null,baseVersion:null,conflict:null,error:null,saving:false\}\n\s*\};/u.exec(source);
    expect(seated?.[1]).toBe("false");
    // And a save puts it back to shut - the literal `saveServiceNote` writes after a 200.
    const saved = /surface\.item\.operationalNotes=typed;\n\s*surface\.serviceNote=\{open:(false|true),/u.exec(source);
    expect(saved?.[1]).toBe("false");
  });

  it("opens with Save and Cancel inside the block, holding the draft rather than the row", () => {
    const app = client("checked_in", GROOMER, { operationalNotes: "Matted behind both ears." });
    app.openServiceNote("Matted behind both ears. Clipped short.");
    const markup = app.serviceNoteMarkup();
    expect(markup).toContain('data-testid="appointment-service-note-input"');
    expect(markup).toContain("Clipped short.");
    expect(markup).toContain('data-testid="appointment-service-note-save"');
    expect(markup).toContain('data-testid="appointment-service-note-cancel"');
    // The heading's Add / Edit stands down while the editor is open: one way to commit.
    expect(button(markup)).toBeNull();
  });

  it("presents a conflict the way the appointment note does: saved beside typed, Save withdrawn", () => {
    const app = client("checked_in", GROOMER, { operationalNotes: "Original." });
    app.openServiceNote("Mine.");
    app.conflictServiceNote("Somebody else's.");
    const markup = app.serviceNoteMarkup();
    expect(markup).toContain('data-testid="appointment-service-note-conflict"');
    expect(markup).toContain("Somebody else's.");
    expect(markup).toContain(">Mine.</textarea>");
    expect(markup).toContain('data-testid="appointment-service-note-conflict-keep"');
    expect(markup).toContain('data-testid="appointment-service-note-conflict-take"');
    expect(markup).not.toContain('data-testid="appointment-service-note-save"');
  });

  it("matches the shape of its sibling, the appointment note's Add / Edit", () => {
    const markup = client("checked_in", EVERYTHING).markup();
    expect(control(markup, "appointment-note-edit")).toContain('class="secondary compact"');
    expect(button(markup)?.[0]).toContain('class="secondary compact"');
  });

  it("is offered on a completed visit too, which is where Rocky's note went missing", () => {
    const found = button(client("completed", GROOMER, { operationalNotes: "Done." }).markup());
    expect(found?.[1]).toBe("Edit");
    expect(found?.[0]).not.toContain("disabled");
    expect(client("completed", GROOMER, SETTLED).derive().editNote).toBe(true);
  });

  it("is absent where the route would refuse the write, and refused where the role cannot", () => {
    for (const status of ["cancelled", "no_show"]) {
      expect(button(client(status, EVERYTHING).markup()), status).toBeNull();
    }
    // A scheduled visit is in the window: the note is taken before the pet arrives.
    expect(button(client("scheduled", EVERYTHING).markup())?.[0]).not.toContain("disabled");
    // Drawn, disabled, and saying why - the shape every other refusal on this surface takes.
    const refused = button(client("checked_in", ["appointments.view"]).markup());
    expect(refused?.[0]).toContain("disabled");
    expect(refused?.[0]).toContain("You do not have permission to write the service note");
    expect(client("checked_in", ["appointments.view"]).markup()).not.toContain('data-testid="appointment-service-note-input"');
  });
});

describe("ownership is a refusal of its own", () => {
  const OTHER = { groomers: [{ id: "e2", displayName: "Sam" }], employeeId: "e2" };
  const SCOPE = "This appointment is assigned to another groomer";

  it("a groomer on another groomer's visit is refused by scope, with the key named", () => {
    const markup = client("checked_in", GROOMER, OTHER).markup();
    expect(control(markup, "appointment-service-note-edit")).toContain("disabled");
    expect(control(markup, "appointment-service-note-edit")).toContain(SCOPE);
    expect(primaries(markup)).toEqual([]);
    const scheduled = client("scheduled", [...GROOMER, "appointments.edit"], OTHER).markup();
    for (const testid of ["appointment-groomer-edit", "appointment-adjust-services", "appointment-note-edit"]) {
      expect(control(scheduled, testid), testid).toContain(SCOPE);
    }
  });

  it("the footer leaves out workflow the assignment refuses and says so in one visible line (QA F6)", () => {
    // Disabled Check In / Ready / Complete held the lead slot with their reason only in a title a
    // phone cannot show. When the refusal is the ASSIGNMENT they are left out of the footer, and
    // one line says whose visit it is; Print Ticket is still there.
    for (const status of ["scheduled", "checked_in", "in_service"]) {
      const markup = client(status, GROOMER, OTHER).markup();
      for (const testid of ["appointment-check-in", "appointment-ready", "appointment-complete"]) {
        expect(control(markup, testid), `${status} ${testid}`).toBeNull();
      }
      expect(markup, status).toMatch(/data-testid="appointment-view-only">Assigned to [^<]+ — view only<\/p>/u);
      expect(markup, status).toMatch(/<div class="surface-head-actions">.*?data-testid="appointment-ticket"/su);
      expect(primaries(markup), status).toEqual([]);
    }
    // The visit's own groomer is not told it is view only.
    expect(client("checked_in", GROOMER).markup()).not.toContain("appointment-view-only");
  });

  it("the permission is asked before the scope: a role without the key is told what it cannot do", () => {
    const markup = client("checked_in", ["appointments.view"], OTHER).markup();
    expect(control(markup, "appointment-ready")).toContain("You do not have permission to mark work as finished");
    expect(control(markup, "appointment-ready")).not.toContain(SCOPE);
  });

  it("appointments.edit_all_staff lifts the scope, and so does owning the visit", () => {
    const lifted = client("checked_in", [...GROOMER, "appointments.edit_all_staff"], OTHER).markup();
    expect(control(lifted, "appointment-ready")).not.toContain("disabled");
    const own = client("checked_in", GROOMER).markup();
    expect(control(own, "appointment-ready")).not.toContain("disabled");
    // Assigned through the groomers list rather than the row's employee column counts too.
    const listed = client("checked_in", GROOMER, { employeeId: "e2", groomers: [{ id: "e2", displayName: "Sam" }, { id: "e1", displayName: "Alex" }] }).markup();
    expect(control(listed, "appointment-ready")).not.toContain("disabled");
  });

  it("a session with no employee record owns nothing", () => {
    const markup = client("checked_in", GROOMER, {}, { me: null }).markup();
    expect(control(markup, "appointment-ready")).toBeNull();
    expect(markup).toContain('data-testid="appointment-view-only"');
    expect(control(markup, "appointment-service-note-edit")).toContain(SCOPE);
  });

  it("money is not scoped: Take Payment answers to checkout.perform alone", () => {
    const markup = client("checked_in", ["appointments.view", "checkout.perform"], OTHER).markup();
    expect(control(markup, "appointment-take-payment")).not.toContain("disabled");
    expect(primaries(markup)).toEqual(["appointment-take-payment"]);
  });

  it("a cancellation is a transition, so Cancel and No-show are scoped too", () => {
    const markup = client("scheduled", ["appointments.view", "appointments.cancel"], OTHER).markup();
    expect(control(markup, "appointment-cancel")).toContain(SCOPE);
    expect(control(markup, "appointment-no-show")).toContain(SCOPE);
    const own = client("scheduled", ["appointments.view", "appointments.cancel"]).markup();
    expect(control(own, "appointment-cancel")).not.toContain("disabled");
  });
});

describe("the calendar card's overflow menu is gated the way the surface is", () => {
  /** `calendarAction` for one card, seen by a role holding `granted` with employee id `me`. */
  function cardMenu(status: string, granted: readonly string[], extra: Record<string, unknown> = {}, me: string | null = "e1"): string {
    const escape = (value = "") =>
      String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const item = { id: "a1", status, petName: "Rex", employeeId: "e1", groomers: [{ id: "e1", displayName: "Alex" }],
      servicesEditable: ["scheduled", "checked_in", "in_service", "completed"].includes(status) && !extra.invoiceId, ...extra };
    const prelude = `
      "use strict";
      const petName = (record) => record.petName || "Pet";
      const granted = new Set(${JSON.stringify(granted)});
      const allowed = (permission) => granted.has(permission);
      const appointmentsLocked = () => false;
      const appointmentMoveAllowed = () => allowed("appointments.edit");
      const appointmentLockNoteMarkup = () => "";
    `;
    const escapeAttr = (value = "") => escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    const factory = new Function("escape", "escapeAttr", "state", [prelude, REFUSAL_COPY, SURFACE, CARD_MENU, `return calendarAction(${JSON.stringify(item)});`].join("\n")) as
      (escape: unknown, escapeAttr: unknown, state: unknown) => string;
    return factory(escape, escapeAttr, { me: { employeeId: me } });
  }
  const OTHER = { employeeId: "e2", groomers: [{ id: "e2", displayName: "Sam" }] };
  const SCOPE = "This appointment is assigned to another groomer";
  const item = (markup: string, label: string): string | null =>
    new RegExp(`<button[^>]*>${label}</button>`, "u").exec(markup)?.[0] ?? null;

  // The groomer preset plus the cancel key, so every scoped item is drawn and the scope alone
  // decides whether it is pressable.
  const CANCELLING = [...GROOMER, "appointments.cancel"];

  it("draws every item a groomer's own card offers pressable", () => {
    const markup = cardMenu("scheduled", CANCELLING);
    expect(item(markup, "Check in")).not.toContain("disabled");
    expect(item(markup, "Move")).not.toContain("disabled");
    expect(item(markup, "Cancel appointment")).not.toContain("disabled");
  });

  it("draws Adjust services disabled with the lock reason once a payment is recorded, whoever holds it", () => {
    for (const status of ["checked_in", "in_service", "completed"]) {
      const locked = item(cardMenu(status, GROOMER, { invoiceId: "inv1", servicesEditable: false }), "Adjust services");
      expect(locked, status).toContain("disabled");
      expect(locked, status).toContain("Services are locked once a payment is recorded. Void the payment to change them");
      // An invoice with no payment on it re-prices instead: the item stays pressable.
      expect(item(cardMenu(status, GROOMER, { invoiceId: "inv1", servicesEditable: true }), "Adjust services"), status).not.toContain("disabled");
      expect(item(cardMenu(status, GROOMER), "Adjust services"), status).not.toContain("disabled");
    }
  });

  it("draws the same items disabled with the scope key on a colleague's card, and Checkout untouched", () => {
    const scheduled = cardMenu("scheduled", CANCELLING, OTHER);
    for (const label of ["Check in", "Move", "Cancel appointment", "No show"]) {
      expect(item(scheduled, label), label).toContain("disabled");
      expect(item(scheduled, label), label).toContain(SCOPE);
    }
    expect(item(cardMenu("checked_in", GROOMER, OTHER), "Start service")).toContain(SCOPE);
    expect(item(cardMenu("checked_in", GROOMER, OTHER), "Adjust services")).toContain(SCOPE);
    expect(item(cardMenu("in_service", GROOMER, OTHER), "Complete")).toContain(SCOPE);
    // Money is not scoped: Checkout on a completed card answers to checkout.perform alone.
    const checkout = item(cardMenu("completed", [...GROOMER, "checkout.perform"], OTHER), "Checkout");
    expect(checkout).not.toContain("disabled");
    // And the permission rule is unchanged: an item this role never holds is absent, not disabled.
    expect(item(cardMenu("scheduled", ["calendar.view", "appointments.view"], OTHER), "Check in")).toBeNull();
    // The all-staff key lifts the scope on the card exactly as on the surface.
    expect(item(cardMenu("scheduled", [...GROOMER, "appointments.edit_all_staff"], OTHER), "Check in")).not.toContain("disabled");
  });
});

describe("the pencil is drawn, not typed", () => {
  it("is an inline stroked path in the groomer block, and the font glyph is gone", () => {
    const markup = client("scheduled", EVERYTHING).markup();
    const pencil = /<button[^>]*data-testid="appointment-groomer-edit"[^>]*>(.*?)<\/button>/su.exec(markup);
    expect(pencil?.[1]).toContain('<svg class="edit-glyph"');
    expect(pencil?.[1]).toContain('aria-hidden="true"');
    expect(pencil?.[1]).not.toContain("&#9998;");
    expect(source).not.toContain("&#9998;");
  });
});
