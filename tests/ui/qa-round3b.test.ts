import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * QA ROUND 3B · SERVICES UNTIL A PAYMENT, ONE INVOICE SURFACE, AND MESSAGES ON A PHONE.
 *
 *   1. Services stay editable until a payment is recorded. The server says so as
 *      `servicesEditable`; an edit on an invoiced visit re-prices the bill and the history says
 *      "Invoice recalculated" with the new total.
 *   2. View Invoice opens one Invoice surface in every settlement state; the settlement decides the
 *      actions - no receipt actions until it is settled.
 *   3. Messages on a phone is a list, then a client, with an arrow back.
 *
 * The functions run as written, sliced out of `public/app.js`, against the smallest fakes they
 * need. The surface's own controls (pencils, + Add service, the card menu, the footer and the head's
 * printer) are held by the existing surface harnesses: appointment-dominant-slot,
 * appointment-services-history, appointment-permission-affordances and checkout-eligibility.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ───────────────────────────────────────────────────────────
 *
 *   `invoiceId` back as the lock instead of `servicesEditable`       "the server's servicesEditable decides"
 *   the old "once the visit is invoiced" copy back                   "the lock says a payment closed it"
 *   `invoice.recalculate` unlabelled, or without its new total       "a re-priced bill is in the history"
 *   receipt actions drawn on an unsettled invoice                    "an unsettled invoice offers no receipt actions"
 *   the phone list not giving way to the client, or no way back      "a phone shows a list, then a client"
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
const testids = (markup: string) => [...markup.matchAll(/data-testid="([^"]+)"/gu)].map((match) => match[1]);

// ─── 1 · services until a payment ────────────────────────────────────────────────────────────

describe("the server's servicesEditable decides", () => {
  const LOCK = slice("const SERVICES_LOCKED_REASON=", "\n// The same rule on a block");
  const app = build<{
    reason: string;
    servicesEditable(item: Record<string, unknown>): boolean;
    servicesLockedByPayment(item: Record<string, unknown>): boolean;
    lockedReason(item: Record<string, unknown>): string;
  }>(`${LOCK}\nreturn { reason: SERVICES_LOCKED_REASON, servicesEditable, servicesLockedByPayment, lockedReason: servicesLockedReason };`, {});

  it("an invoiced visit with no payment on it is editable - the invoice alone locks nothing", () => {
    const open = { status: "completed", invoiceId: "inv-1", invoiceStatus: "open", servicesEditable: true };
    expect(app.servicesEditable(open)).toBe(true);
    expect(app.servicesLockedByPayment(open)).toBe(false);
  });

  it("a recorded payment is what locks it, from check-in through completed", () => {
    for (const status of ["scheduled", "checked_in", "in_service", "completed"]) {
      const paid = { status, invoiceId: "inv-1", invoiceStatus: "partially_paid", servicesEditable: false };
      expect(app.servicesEditable(paid), status).toBe(false);
      expect(app.servicesLockedByPayment(paid), status).toBe(true);
    }
  });

  it("a cancelled visit is neither: it is outside the window, not locked by money", () => {
    const gone = { status: "cancelled", invoiceId: null, servicesEditable: false };
    expect(app.servicesEditable(gone)).toBe(false);
    expect(app.servicesLockedByPayment(gone)).toBe(false);
  });

  it("an older projection without the field is not editable - the client never guesses", () => {
    expect(app.servicesEditable({ status: "scheduled", invoiceId: null })).toBe(false);
  });

  it("a settled bill - a $0 one its coupon settled included - says it is settled, not to void a payment", () => {
    const settled = { status: "completed", invoiceId: "inv-1", invoiceStatus: "paid", servicesEditable: false };
    expect(app.servicesLockedByPayment(settled)).toBe(true);
    expect(app.lockedReason(settled)).toBe("Services are locked once the bill is settled");
    const partly = { status: "completed", invoiceId: "inv-1", invoiceStatus: "partially_paid", servicesEditable: false };
    expect(app.lockedReason(partly)).toBe(app.reason);
  });

  it("the lock says a payment closed it, and how to open it again", () => {
    expect(app.reason).toBe("Services are locked once a payment is recorded. Void the payment to change them");
  });
});

describe("a re-priced bill is in the history", () => {
  const ACTIVITY = slice("const APPOINTMENT_ACTIVITY_LABELS=", "\n// THE FALLBACK for a visit that predates");
  const line = build<(entry: Record<string, unknown>) => { what: string; details: string[] }>(
    `${ACTIVITY}\nreturn appointmentActivityLine;`,
    { formatPrefDateAndTime: () => "10/06/2026 6:09 PM", money: (minor: number) => `$${(minor / 100).toFixed(2)}` }
  );

  it("says Invoice recalculated and the new total to a caller who may see money", () => {
    const entry = line({ action: "invoice.recalculate", totalMinor: 13207, at: "2026-10-06T18:09:00Z", actor: { label: "Olivia Owner" } });
    expect(entry.what).toBe("Invoice recalculated");
    expect(entry.details).toEqual(["New total $132.07"]);
  });

  it("says the label alone where the server withheld the amount", () => {
    expect(line({ action: "invoice.recalculate", totalMinor: null, at: "2026-10-06T18:09:00Z" }).details).toEqual([]);
  });
});

// ─── 2 · one Invoice surface; the settlement decides the actions ─────────────────────────────

describe("an unsettled invoice offers no receipt actions", () => {
  const ACTIONS = slice("function invoiceDocumentActionsMarkup(receipt){", "\n/**\n * THE VISIT, ABOVE THE MONEY.");
  const app = build<{ actions(receipt: unknown): string; note(receipt: unknown): string }>(
    `${ACTIONS}\nreturn { actions: invoiceDocumentActionsMarkup, note: invoiceUnavailableNoteMarkup };`,
    {
      escape, escapeAttr: escape,
      receiptSettlementComplete: (receipt: { settled: boolean }) => receipt.settled,
      invoiceUnavailableReason: () => "Not built yet.",
      invoiceCanTakePayment: (receipt: { owing: boolean }) => receipt.owing
    }
  );

  it("unpaid or partly paid: Print Invoice and Take Payment, nothing about a receipt", () => {
    const markup = app.actions({ settled: false, owing: true });
    expect(testids(markup)).toEqual(["invoice-document-actions", "invoice-print-invoice", "invoice-take-payment"]);
    expect(app.note({ settled: false })).toBe("");
  });

  it("paid: Print Invoice beside Print Receipt, Send Receipt and Ask for Review, and no payment action", () => {
    const markup = app.actions({ settled: true, owing: false });
    expect(testids(markup)).toEqual([
      "invoice-document-actions", "invoice-print-invoice", "invoice-print-receipt", "invoice-send-receipt", "invoice-ask-review"
    ]);
    expect(app.note({ settled: true })).toContain('data-testid="invoice-unavailable-note"');
  });
});

// ─── 3 · Messages on a phone ─────────────────────────────────────────────────────────────────

describe("a phone shows a list, then a client", () => {
  const MESSAGES = slice("async function selectMessageClient(id){", "\nconst reminderTabs=");

  function fakeElement() {
    const classes = new Set<string>(), listeners = new Map<string, () => void>();
    return {
      classes, listeners, innerHTML: "", focused: false, scrolled: false,
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      focus() { this.focused = true; },
      scrollIntoView() { this.scrolled = true; }
    };
  }
  function harness(phone: boolean) {
    const workspace = fakeElement(), thread = fakeElement(), back = fakeElement(), row = fakeElement(), section = fakeElement();
    const elements: Record<string, ReturnType<typeof fakeElement>> = {
      ".messages-workspace": workspace, "#message-thread": thread, "#message-thread [data-message-back]": back,
      '#message-client-list [data-message-client="c1"]': row, "#messages": section
    };
    const state: Record<string, unknown> = { pets: [], clientProfile: null, messageClientId: null };
    const app = build<{ select(id: string): Promise<void>; close(): void }>(`${MESSAGES}\nreturn { select: selectMessageClient, close: closeMessageClient };`, {
      $: (selector: string) => elements[selector] ?? null,
      state,
      api: async () => ({ customer: { id: "c1", name: "Sophia Chen" }, pets: [] }),
      loadClientNotes: async () => [], loadClientAgreements: async () => [],
      HISTORY_INITIAL_ROWS: 10, renderMessages: () => {}, renderClientSummaryPane: () => {},
      clientName: (customer: { name: string }) => customer.name, escape,
      globalThis: { matchMedia: () => ({ matches: phone }) }
    });
    return { app, workspace, thread, back, row, section };
  }

  it("choosing a client swaps the list for the client and draws the way back", async () => {
    const { app, workspace, thread, back, section } = harness(true);
    await app.select("c1");
    expect(workspace.classes.has("is-client-open")).toBe(true);
    expect(thread.innerHTML).toContain('<button type="button" class="message-back" data-message-back aria-label="Back to clients">');
    expect(back.listeners.has("click")).toBe(true);
    expect(section.scrolled).toBe(true);
  });

  it("the arrow returns to the list with the chosen client still marked and focused", async () => {
    const { app, workspace, back, row } = harness(true);
    await app.select("c1");
    back.listeners.get("click")!();
    expect(workspace.classes.has("is-client-open")).toBe(false);
    expect(row.focused).toBe(true);
  });

  it("a desk does not scroll: its three panes are already side by side", async () => {
    const { app, section } = harness(false);
    await app.select("c1");
    expect(section.scrolled).toBe(false);
  });
});
