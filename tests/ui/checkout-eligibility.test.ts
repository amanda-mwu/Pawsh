import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appointmentStatuses, canEnterCheckout } from "@pawsh/domain";

/**
 * THE FOOTER MAY NOT OFFER A CHECKOUT THE ROUTE WOULD REFUSE.
 *
 * `POST /api/appointments/:id/checkout` bills a `checked_in` or a `completed` visit and answers
 * the other four with a 409. This file runs the surface's REAL `derive()` and its REAL footer
 * markup out of `public/app.js` - not a paraphrase of them - and checks the same six statuses
 * against `canEnterCheckout`, which is the rule the server asks.
 *
 * The client is served as a plain script and cannot import `@pawsh/domain`, so the list is
 * written out in `derive()` and held to the domain here. That is the whole reason this file
 * compares against `canEnterCheckout` rather than against a second hand-written list: a widening
 * on one side and not the other is exactly the defect worth catching.
 *
 * --- WHAT A MUTATION HAS TO BREAK --------------------------------------------------------------
 *
 *   `["checked_in","completed"].includes(status)` -> `status==="completed"`
 *       "offers Take Payment on the two billable statuses" fails on `checked_in`.
 *
 *   the same -> `true`, or the list gains `in_service`
 *       "withholds it on every status the server refuses" fails.
 *
 *   `primarySlot==="checkout"?"secondary":"primary"` on Save -> `"primary"`
 *       "draws one primary button" fails.
 *
 *   `&&(!invoiced||appointmentInvoiceOutstanding(...))` dropped from `checkout`
 *       "withholds Take Payment once the bill is settled" fails.
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/** The footer markup, and the permission-refusal attributes it interpolates. */
const SURFACE = slice(
  "function appointmentPermissionRefusal(action,permission){",
  "\n/**\n * The appointment detail surface: level 1 of the stack."
);
/** The single place the surface decides what this actor may do with this visit. */
const DERIVE = slice("  const derive=()=>{", "\n  /**\n   * The appointment note redraws");
/** Whether a bill that exists still owes anything. */
const OUTSTANDING = slice(
  "const OUTSTANDING_INVOICE_STATUSES=",
  "\n// Minutes as an operator says them."
);
/** The note block, because the footer markup is sliced from the function above it. */
const NOTES = slice(
  "function appointmentRecordNoteMarkup(surface){",
  "\nfunction appointmentPermissionRefusal("
);

interface Module {
  derive(): Record<string, boolean>;
  markup(): string;
}

/** A visit in one status, optionally carrying a bill in one settlement state. */
function client(status: string, invoice: Record<string, unknown> = {}): Module {
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
    ...invoice
  };

  const prelude = `
    "use strict";
    const money = (minor) => "$" + (Number(minor || 0) / 100).toFixed(2);
    const petName = (record) => record.petName || "Pet";
    // EVERY PERMISSION HELD. This file is about which STATUSES are billable; the permission half
    // of the same flag has its own file, and granting everything keeps the two from masking
    // each other.
    const allowed = () => true;
    const appointmentsLocked = () => false;
    const appointmentMoveAllowed = () => true;
    const appointmentBillingChip = () => ({ tone: "neutral", label: "Unbilled" });
    const appointmentLockNoteMarkup = () => "";
    const appointmentActivityMarkup = () => "<!--activity-->";
    const appointmentLifecycleMarkup = () => "<!--lifecycle-->";
    const appointmentPhotosMarkup = () => "<!--photos-->";
    const appointmentReportCardsMarkup = () => "<!--report-cards-->";
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
      derive,
      markup: () => { surface.permissions = derive(); return appointmentSurfaceMarkup(surface); }
    };`;
  const scope: Record<string, unknown> = { escape, escapeAttr, state: { clientProfile: null, pets: [] } };
  const names = Object.keys(scope);
  const factory = new Function(
    ...names, [prelude, OUTSTANDING, NOTES, SURFACE, DERIVE, exported].join("\n")
  ) as (...args: unknown[]) => Module;
  return factory(...names.map((name) => scope[name]));
}

/** The opening tag of one control, or null when the footer drew none. */
function control(markup: string, testid: string): string | null {
  return new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`, "u").exec(markup)?.[0] ?? null;
}

describe("the checkout affordance follows the server's own eligibility rule", () => {
  it("offers Take Payment on exactly the statuses the route bills", () => {
    for (const status of appointmentStatuses) {
      const app = client(status);
      const offered = app.derive().checkout;
      expect(offered, `${status}: client and server disagree about billing`)
        .toBe(canEnterCheckout(status));
      // And the flag reaches the footer rather than stopping at the derivation.
      expect(Boolean(control(app.markup(), "appointment-take-payment")), `${status}: footer`)
        .toBe(canEnterCheckout(status));
    }
  });

  it("withholds it on every status the server refuses", () => {
    for (const status of ["scheduled", "in_service", "cancelled", "no_show"]) {
      const app = client(status);
      expect(app.derive().checkout, status).toBe(false);
      expect(control(app.markup(), "appointment-take-payment"), status).toBeNull();
    }
  });

  it("keeps offering it while a checked-in visit still owes money", () => {
    const app = client("checked_in", {
      invoiceId: "inv-1", invoiceStatus: "partially_paid", invoiceBalanceMinor: 4000
    });
    expect(app.derive().checkout).toBe(true);
    expect(control(app.markup(), "appointment-take-payment")).not.toBeNull();
  });

  it("withholds Take Payment once the bill is settled, in either billable status", () => {
    for (const status of ["checked_in", "completed"]) {
      const app = client(status, { invoiceId: "inv-1", invoiceStatus: "paid", invoiceBalanceMinor: 0 });
      expect(app.derive().checkout, status).toBe(false);
      expect(control(app.markup(), "appointment-take-payment"), status).toBeNull();
      // The bill itself stays reachable from the visit that raised it.
      expect(control(app.markup(), "appointment-invoice"), status).not.toBeNull();
    }
  });

  it("draws one primary button on a checked-in footer, not two", () => {
    // Save is the primary action on a visit still being worked, and Take Payment never used to
    // appear beside it. They meet now, and the footer's `primarySlot` rule decides which is which.
    const markup = client("checked_in").markup();
    const save = control(markup, "appointment-save");
    const take = control(markup, "appointment-take-payment");
    expect(save, "Save was not drawn on a checked-in visit").not.toBeNull();
    expect(take, "Take Payment was not drawn on a checked-in visit").not.toBeNull();
    expect(take).toContain("primary");
    expect(save).not.toContain("primary");
  });

  it("gives the slot to the workflow action where there is nothing to collect", () => {
    // An in-service visit cannot be billed, so the thing it is waiting for is Complete - and
    // Save yields to it exactly as it yields to Take Payment on a checked-in one. One primary,
    // whichever it is.
    const markup = client("in_service").markup();
    expect(control(markup, "appointment-take-payment")).toBeNull();
    expect(control(markup, "appointment-complete")).toContain("primary");
    expect(control(markup, "appointment-save")).not.toContain("primary");
    expect([...markup.matchAll(/<button[^>]*class="primary /gu)]).toHaveLength(1);
  });
});

describe("the checked-in footer offers the three things a counter does", () => {
  it("draws Ready for Pickup, Take Payment and Save, and exactly one primary", () => {
    const markup = client("checked_in").markup();
    const ready = control(markup, "appointment-ready");
    const take = control(markup, "appointment-take-payment");
    const save = control(markup, "appointment-save");

    expect(ready, "Ready for Pickup was not drawn").not.toBeNull();
    expect(take, "Take Payment was not drawn").not.toBeNull();
    expect(save, "Save was not drawn").not.toBeNull();
    // Money outranks the rest, which is the footer's own stated rule.
    expect(take).toContain("primary");
    expect(ready).not.toContain("primary");
    expect(save).not.toContain("primary");
    expect([...markup.matchAll(/<button[^>]*class="primary /gu)]).toHaveLength(1);
  });

  it("starts Save asleep, because nothing has been changed yet", () => {
    // A Save that is always pressable says an edit is waiting when none is, and pressing it
    // writes the note back over itself. What wakes it is the textarea differing from what was
    // loaded, which only a live surface can do - `tests/e2e/checked-in-footer.spec.ts` walks it.
    const save = control(client("checked_in").markup(), "appointment-save");
    expect(save).toContain("disabled");
    expect(save).toContain('aria-disabled="true"');
  });

  it("offers Ready for Pickup on a checked-in visit and on no other", () => {
    // `in_service` is left out on purpose: a visit on the table already has a name for finishing,
    // and it is the calendar card's own "Complete". Two words for one transition is one too many.
    for (const status of appointmentStatuses) {
      const drawn = Boolean(control(client(status).markup(), "appointment-ready"));
      expect(drawn, status).toBe(status === "checked_in");
    }
  });

  it("keeps Ready for Pickup and Take Payment as separate questions", () => {
    // Billed at drop-off: the bill is settled and the pet is still in the salon, so Take Payment
    // has gone and Ready for Pickup has not. Neither control is evidence about the other.
    const settled = client("checked_in", {
      invoiceId: "inv-1", invoiceStatus: "paid", invoiceBalanceMinor: 0
    }).markup();
    expect(control(settled, "appointment-take-payment")).toBeNull();
    expect(control(settled, "appointment-ready")).not.toBeNull();
    expect(control(settled, "appointment-invoice")).not.toBeNull();
  });
});

/**
 * THE FOOTER IS A WORK SURFACE IN EVERY STATUS, NOT ONLY THE ONES THAT HANDLE MONEY.
 *
 * A scheduled visit used to open onto five identical grey pills and no primary at all - Cancel,
 * No-show, Book Again, Print, Ticket - so the screen an operator opened to DO something with the
 * visit offered them nothing to do. Checking a pet in existed only on the calendar card, which
 * meant closing the appointment, finding the card and pressing the small control on it.
 *
 * Access, lifecycle and money are three separate questions and this block asserts them apart:
 * every status can be opened and edited where the route allows, exactly one lifecycle action is
 * offered per status, and Take Payment follows `canEnterCheckout` and nothing else.
 */
describe("every status offers the one thing it is waiting for", () => {
  const workflow = (markup: string): string[] =>
    ["appointment-check-in", "appointment-ready", "appointment-complete"]
      .filter((testid) => control(markup, testid) !== null);

  it("offers exactly one lifecycle action per status, and names it for that status", () => {
    const expected: Record<string, string[]> = {
      scheduled: ["appointment-check-in"],
      checked_in: ["appointment-ready"],
      in_service: ["appointment-complete"],
      completed: [], cancelled: [], no_show: []
    };
    for (const status of appointmentStatuses) {
      expect(workflow(client(status).markup()), status).toEqual(expected[status]);
    }
  });

  it("makes Check In the primary on a scheduled visit", () => {
    // The visit is waiting for exactly one thing and there is no money to take, so the thing it
    // is waiting for takes the slot. Before this a scheduled footer had no primary at all.
    const markup = client("scheduled").markup();
    expect(control(markup, "appointment-check-in")).toContain("primary");
    expect(control(markup, "appointment-take-payment")).toBeNull();
    expect(control(markup, "appointment-ready")).toBeNull();
    expect([...markup.matchAll(/<button[^>]*class="primary /gu)]).toHaveLength(1);
  });

  it("keeps money ahead of the lifecycle on a checked-in visit", () => {
    const markup = client("checked_in").markup();
    expect(control(markup, "appointment-take-payment")).toContain("primary");
    expect(control(markup, "appointment-ready")).not.toContain("primary");
    expect([...markup.matchAll(/<button[^>]*class="primary /gu)]).toHaveLength(1);
  });

  it("never offers checkout where the route refuses it, whatever else the footer gained", () => {
    for (const status of appointmentStatuses) {
      expect(Boolean(control(client(status).markup(), "appointment-take-payment")), status)
        .toBe(canEnterCheckout(status));
    }
  });

  it("lets the services be edited in every status the route accepts, and not after a bill exists", () => {
    // ACCESS IS NOT GATED BY CHECK-IN. `PUT /api/appointments/:id/services` accepts all three of
    // these, and the surface now offers all three.
    for (const status of ["scheduled", "checked_in", "in_service"]) {
      expect(control(client(status).markup(), "appointment-adjust-services"), status).not.toBeNull();
    }
    // The route refuses once an invoice exists, so the control goes rather than producing a
    // sentence nobody can act on.
    const billed = client("checked_in", { invoiceId: "inv-1", invoiceStatus: "open", invoiceBalanceMinor: 8500 });
    expect(control(billed.markup(), "appointment-adjust-services")).toBeNull();
  });

  it("draws one ticket action and no second route to the same document", () => {
    // `Print` made an agenda extract and `Ticket` made the work sheet, in identical grey pills,
    // and a header icon was bound to the very same closure as `Ticket`. One document, one door.
    for (const status of appointmentStatuses) {
      const markup = client(status).markup();
      expect(control(markup, "appointment-ticket"), status).not.toBeNull();
      expect(control(markup, "appointment-print"), status).toBeNull();
      expect(control(markup, "appointment-ticket-print"), status).toBeNull();
      expect(markup, status).toContain("Print Ticket");
    }
  });

  it("keeps a cancelled or no-show visit readable rather than shutting it", () => {
    // History is not made inaccessible by being terminal: the sheet is still printable and the
    // record still opens. What is absent is everything that would move or bill it.
    for (const status of ["cancelled", "no_show"]) {
      const markup = client(status).markup();
      expect(control(markup, "appointment-ticket"), status).not.toBeNull();
      expect(control(markup, "appointment-close"), status).not.toBeNull();
      expect(control(markup, "appointment-take-payment"), status).toBeNull();
      expect(workflow(markup), status).toEqual([]);
    }
  });
});

/**
 * THE FOOTER IS TWO ZONES, AND THE ONE THING THE VISIT IS WAITING FOR IS ALONE IN ONE OF THEM.
 *
 * It was a flat run of five or six identically-weighted pills. A scheduled visit had no primary
 * at all, and Ready for Pickup was reported by human QA as unavailable on a checked-in visit
 * where it was drawn, enabled and working - it was the fifth grey pill from the left.
 */
describe("the footer separates what the visit is waiting for from everything else", () => {
  /** The test ids in one zone, in the order the footer draws them. */
  const zone = (markup: string, name: "lead" | "utility"): string[] => {
    const block = new RegExp(`<div class="surface-foot-actions surface-foot-${name}">(.*?)</div>`, "su")
      .exec(markup)?.[1] ?? "";
    return [...block.matchAll(/data-testid="([^"]+)"/gu)].map((match) => match[1]!);
  };

  it("puts exactly the work in the lead zone, and everything else out of it", () => {
    const expected: Record<string, { lead: string[]; utility: string[] }> = {
      scheduled: {
        lead: ["appointment-check-in"],
        utility: ["appointment-cancel", "appointment-no-show", "appointment-book-again", "appointment-ticket"]
      },
      checked_in: {
        lead: ["appointment-ready", "appointment-save", "appointment-take-payment"],
        utility: ["appointment-book-again", "appointment-ticket"]
      },
      in_service: {
        lead: ["appointment-save", "appointment-complete"],
        utility: ["appointment-book-again", "appointment-ticket"]
      },
      completed: {
        lead: ["appointment-take-payment"],
        utility: ["appointment-book-again", "appointment-ticket"]
      },
      cancelled: { lead: [], utility: ["appointment-ticket", "appointment-close"] },
      no_show: { lead: [], utility: ["appointment-ticket", "appointment-close"] }
    };
    for (const status of appointmentStatuses) {
      const markup = client(status).markup();
      expect(zone(markup, "lead"), `${status} lead`).toEqual(expected[status]!.lead);
      expect(zone(markup, "utility"), `${status} utility`).toEqual(expected[status]!.utility);
    }
  });

  it("never crowds the lead zone past three controls", () => {
    // Three is the worst case and it is checked-in: the money, the next step, and the Save that
    // belongs beside it. Everything else was moved out rather than made smaller.
    for (const status of appointmentStatuses) {
      expect(zone(client(status).markup(), "lead").length, status).toBeLessThanOrEqual(3);
    }
  });

  it("gives Ready for Pickup a rank of its own, below the money and above the utilities", () => {
    // Reported as unavailable because it looked exactly like Book Again. It is a secondary - two
    // primaries is what this footer exists to prevent - but not a quiet one.
    const ready = control(client("checked_in").markup(), "appointment-ready");
    expect(ready).toContain("secondary");
    expect(ready).toContain("is-strong");
    expect(ready).not.toContain("primary");
    // And nothing else in the footer borrows that rank.
    const markup = client("checked_in").markup();
    expect([...markup.matchAll(/is-strong/gu)]).toHaveLength(1);
  });

  it("keeps the settled bill leading its own visit", () => {
    const markup = client("completed", {
      invoiceId: "inv-1", invoiceStatus: "paid", invoiceBalanceMinor: 0
    }).markup();
    expect(zone(markup, "lead")).toEqual(["appointment-invoice"]);
    expect(control(markup, "appointment-invoice")).toContain("primary");
    expect(zone(markup, "utility")).toEqual(["appointment-ticket", "appointment-close"]);
  });
});
