import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { permissionPresets } from "@pawsh/domain";

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
 *   THE SERVICE NOTE SAYS IT IS EDITABLE (C1) - a named Add / Edit on its heading, the shape its
 *       sibling has always had.
 *   THE ASLEEP SAVE SAYS WHY (E1) - the reason rides on the control as its title, the way every
 *       other refusal on this footer does, and nowhere else.
 *   THE PENCIL IS DRAWN, NOT TYPED (A3) - an inline stroked path in currentColor, so its contrast
 *       is the button's, not the platform symbol font's.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `dominantAction` returns the first OFFERED name regardless of `enabled`
 *       "a settled visit never leads with an Invoice the role cannot open" and "a refused Check
 *       In does not hold the slot" fail: the refusal is promoted again.
 *   `["ready", ...]` removed from the ranking
 *       "a groomer's checked-in footer leads with Ready for Pickup" fails: nothing enabled
 *       outranks the utilities, and no primary is drawn where one is due.
 *   `["invoice", can.invoice, true]`
 *       "a settled visit never leads with an Invoice the role cannot open" fails.
 *   Save given `primarySlot===null?"primary":...`
 *       "no enabled lead action means no primary, not a blue disabled one" fails.
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
  "function appointmentPermissionRefusal(action,permission){",
  "\n/**\n * The appointment detail surface: level 1 of the stack."
);
const DERIVE = slice("  const derive=()=>{", "\n  /**\n   * The appointment note redraws");

interface Module {
  derive(): Record<string, boolean>;
  markup(): string;
  dominantAction(ranking: Array<[string, boolean, boolean]>): string | null;
}

const GROOMER = permissionPresets.groomer!;
const EVERYTHING = [
  ...new Set(Object.values(permissionPresets).flat())
];

/** A visit in one status, seen by a role holding exactly `granted`. */
function client(
  status: string, granted: readonly string[], extra: Record<string, unknown> = {}
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
      permissions: null
    };
    const HISTORY_INITIAL_ROWS = 10;
  `;
  const exported = `
    return {
      derive, dominantAction,
      markup: () => { surface.permissions = derive(); return appointmentSurfaceMarkup(surface); }
    };`;
  const scope: Record<string, unknown> = { escape, escapeAttr, state: { clientProfile: null, pets: [] } };
  const names = Object.keys(scope);
  const factory = new Function(
    ...names, [prelude, NOTES, SURFACE, DERIVE, exported].join("\n")
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

  it("Save is never the primary, because it is never pressable at draw time", () => {
    for (const [status, role] of [["checked_in", GROOMER], ["in_service", GROOMER], ["checked_in", EVERYTHING]] as const) {
      const save = control(client(status, role).markup(), "appointment-save");
      expect(save, `${status}`).toContain("disabled");
      expect(save, `${status}`).not.toContain('class="primary');
    }
  });

  it("the owner's checked-in footer is unchanged: the money leads, Ready is the strong secondary", () => {
    const markup = client("checked_in", EVERYTHING).markup();
    expect(primaries(markup)).toEqual(["appointment-take-payment"]);
    expect(control(markup, "appointment-ready")).toContain("secondary is-strong");
  });

  it("a settled visit never leads with an Invoice the role cannot open", () => {
    const markup = client("completed", GROOMER, SETTLED).markup();
    const invoice = control(markup, "appointment-invoice");
    // Still drawn, still disabled, still naming the reason - it is a document that exists.
    expect(invoice).toContain("disabled");
    expect(invoice).toContain("permission to view invoices");
    expect(invoice).not.toContain('class="primary');
    // The slot passes to the next enabled action, which on a completed visit is the sheet.
    expect(primaries(markup)).toEqual(["appointment-ticket"]);
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
    // Ready for Pickup is drawn refused, Save is drawn asleep, and neither is promoted.
    const markup = client("checked_in", ["appointments.view", "operations.perform_service"]).markup();
    expect(zone(markup, "lead")).toEqual(["appointment-ready", "appointment-save"]);
    expect(control(markup, "appointment-ready")).toContain("disabled");
    expect(control(markup, "appointment-save")).toContain("disabled");
    expect(primaries(markup)).toEqual([]);
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

  it("a completed, unbilled visit offers a groomer no primary rather than a disabled one", () => {
    // Nothing enabled remains in the lead zone - no money, no invoice, no transition - and the
    // visit is not read-only, so neither the sheet nor Close is promoted in its place.
    const markup = client("completed", GROOMER).markup();
    expect(primaries(markup)).toEqual([]);
    expect(control(markup, "appointment-take-payment")).toBeNull();
    expect(control(markup, "appointment-invoice")).toBeNull();
  });

  it("a cancelled visit keeps Close as its primary, because there is nothing else to come for", () => {
    expect(primaries(client("cancelled", GROOMER).markup())).toEqual(["appointment-close"]);
  });
});

describe("the asleep Save says why", () => {
  it("carries its reason as a title while disabled, in both statuses that offer it", () => {
    for (const status of ["checked_in", "in_service"]) {
      const save = control(client(status, GROOMER).markup(), "appointment-save");
      expect(save, status).toContain('aria-disabled="true"');
      expect(save, status).toMatch(/title="Nothing to save yet\./u);
    }
  });

  it("adds no permanent sentence to the footer", () => {
    const markup = client("checked_in", GROOMER).markup();
    const foot = /<footer class="surface-foot">(.*)<\/footer>/su.exec(markup)?.[1] ?? "";
    expect(foot.replace(/<[^>]+>/gu, "")).not.toContain("Nothing to save yet");
  });
});

describe("the service note says it is editable", () => {
  const button = (markup: string) =>
    /<button[^>]*data-testid="appointment-service-note-edit"[^>]*>([^<]*)<\/button>/u.exec(markup);

  it("offers Add on an empty note, beside the open field", () => {
    const markup = client("checked_in", GROOMER).markup();
    const found = button(markup);
    expect(found?.[1]).toBe("Add");
    expect(found?.[0]).toContain('aria-label="Add service note"');
    expect(markup).toContain('data-testid="appointment-note-input"');
  });

  it("offers Edit once a note is held, following what the server holds", () => {
    const markup = client("in_service", GROOMER, { operationalNotes: "Matted behind both ears." }).markup();
    const found = button(markup);
    expect(found?.[1]).toBe("Edit");
    expect(found?.[0]).toContain('aria-label="Edit service note"');
  });

  it("matches the shape of its sibling, the appointment note's Add / Edit", () => {
    const markup = client("checked_in", EVERYTHING).markup();
    expect(control(markup, "appointment-note-edit")).toContain('class="secondary compact"');
    expect(button(markup)?.[0]).toContain('class="secondary compact"');
  });

  it("is absent exactly where the field is: before check-in, and without the permission", () => {
    expect(button(client("scheduled", EVERYTHING).markup())).toBeNull();
    expect(button(client("checked_in", ["appointments.view"]).markup())).toBeNull();
    expect(client("checked_in", ["appointments.view"]).markup()).not.toContain('data-testid="appointment-note-input"');
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
