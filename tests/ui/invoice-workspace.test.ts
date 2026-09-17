import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE INVOICE IS A WORKSPACE, AND CONVERTING IT INTO ONE CHANGED NO RULE ABOUT THE DOCUMENTS.
 *
 * The Invoice used to be drawn into `#modal`: a 650px form dialog with a two-column field grid, a
 * footer belonging to a form, and a green Save that saved nothing. An operator reading a settled
 * bill had a narrow column of simulated paper and had to scroll past the bottom of it to reach the
 * two controls that mattered. It is a full-screen surface now — a head that names the document, a
 * two-column body, and a footer whose actions are the document's own.
 *
 * ─── WHAT THIS FILE HOLDS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────
 *
 * It holds what the workspace SAYS and what its controls DO, deterministically, against fixtures.
 * The browser half — which door opens it, that a narrow viewport does not overflow, that closing
 * it lands the operator back where they came from — is `tests/e2e/invoice-workspace.spec.ts`,
 * because none of those can be answered without layout.
 *
 * The money statement itself is NOT re-tested here. It is `receiptBodyMarkup`, the shared
 * renderer, and `tests/ui/payment-receipt.test.ts` holds every figure, every void rule and every
 * refund convention on it. What matters here is that the workspace HOSTS that renderer rather than
 * carrying a second, thinner reading of the same invoice beside it — which is asserted directly,
 * because a second money renderer is the one change this conversion was not allowed to make.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `receiptSettlementComplete` → `receiptHasPayment` in `invoiceDocumentActionsMarkup`
 *       the two Receipt gates collapse into one. "a part-settled invoice offers no Receipt" fails.
 *
 *   dropping `disabled` from `invoiceDocumentActionsMarkup`'s `unavailable()`
 *       Send Receipt and Ask for Review become pressable controls behind capabilities that do not
 *       exist. "they are drawn, disabled, and bound to nothing" fails.
 *
 *   `invoiceVisitFactsMarkup` drawing the lifecycle rows with a null appointment
 *       a visit whose appointment could not be read is reported as having no check-in time.
 *       "absent is not the same claim as not recorded" fails.
 *
 * Each of the three was applied to `public/app.js`, run against this file, and reverted.
 */
const source = readFileSync("public/app.js", "utf8");

/** One region of the client, by the declarations that bound it. */
function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/** The two Receipt gates, the settled-component reading, and the two document titles. */
const GATES = slice("function receiptHasPayment(", "\nfunction toast(");
/** Refunds read off the receipt, which the statement renders under the component they reversed. */
const REFUNDS = slice("function receiptRefundsFor(", "\nfunction salonIdentityOf(");
/** The salon identity header and the Invoice's shared money statement. */
const RENDERERS = slice(
  "function salonIdentityOf(",
  "\n// Scoped to the copy of the receipt that was just rendered"
);
/** The workspace: its footer controls, its visit facts, its settlement panel and its shell. */
const WORKSPACE = slice(
  "const INVOICE_UNAVAILABLE_REASON=",
  "\n/**\n * Opens the Invoice workspace"
);
/** The lifecycle helpers the visit facts read through, run rather than restated. */
const LIFECYCLE_TIMES = slice(
  "function appointmentLifecycleTimes(activity){",
  "\nfunction appointmentActivityMarkup("
);
const LIFECYCLE_VALUES = slice(
  "function appointmentLifecycleValues(item,activity){",
  "\n// The Invoice and the Receipt, through"
);
const DURATION = slice(
  "function lifecycleDurationLabel(minutes){",
  "\n/**\n * Checked in, checked out and duration - THE STORED COLUMNS FIRST"
);
/** The stamp on a lifecycle time, which is how it reaches the preference layer. */
const STAMP = slice("function activityStamp(value){", "\nfunction appointmentActivityLine(");

/** The stub's output, distinctive enough that a raw `Intl` call could not produce it by accident. */
const PREFERRED_STAMP = "«preference-layer stamp»";

interface ClientModule {
  invoiceWorkspaceMarkup(receipt: unknown, appointment: unknown): string;
  invoiceDocumentActionsMarkup(receipt: unknown): string;
  invoiceSettlementPanelMarkup(receipt: unknown): string;
  invoiceVisitFactsMarkup(receipt: unknown, appointment: unknown): string;
  bindInvoiceWorkspace(root: unknown, receipt: unknown): void;
  /** Every document a print control put on paper, in order. */
  printed: { document: string }[];
}

function loadClient(): ClientModule {
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const escapeAttr = (value = "") =>
    escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const prelude = `
    "use strict";
    const money = (minor) => "$" + (Number(minor || 0) / 100).toFixed(2);
    const clientName = (record) =>
      [record.firstName, record.lastName].filter(Boolean).join(" ").trim() || "Not set";
    const petName = (record) => record.petName || "Unnamed pet";
    const paymentMethodLabel = (method) =>
      ({cash:"Cash",external_card:"Card",check:"Check",other:"Other",client_credit:"Client credit"})[method]
        || String(method || "").replaceAll("_", " ");
    const taxPayPercent = (basisPoints) => (Number(basisPoints || 0) / 100).toFixed(2);
    // THE PREFERENCE LAYER, STUBBED SO ITS ABSENCE WOULD SHOW. A renderer that formatted a stamp
    // itself — through Intl, through toLocaleString, through anything — would stop producing the
    // sentinel, and the assertions below would read the runner's locale instead of failing.
    const formatPrefDateAndTime = (instant) =>
      ${JSON.stringify(PREFERRED_STAMP)} + " " + instant.toISOString();
    const formatPrefDate = (instant) => "«date» " + instant.toISOString().slice(0, 10);
    // Mirrors INVOICE_STATUS_LABELS, which lives above the slices.
    const invoiceStatusLabel = (status) =>
      ({draft:"Draft",open:"Open",partially_paid:"Partially paid",paid:"Paid",
        partially_refunded:"Partly refunded",refunded:"Refunded",void:"Void"})[status]
        || String(status || "").replaceAll("_", " ");
    // The pet is the only thing the workspace reads off the presentation model, and the model is a
    // 30-field calendar projection tested by its own spec.
    const appointmentPresentation = (item) => ({petName:item.petName});

    // THE ACTOR. The statement's own correction controls are gated on \`checkout.perform\`; this
    // file is about the document, so nobody here may correct anything.
    const allowed = () => false;

    // Print, recorded. WHICH document each control produces is the question; how a document
    // reaches paper is \`tests/ui/print-preview.test.ts\`.
    const printed = [];
    const printInvoiceDocument = (receipt) => { printed.push({document:"invoice", receipt}); };
    const printPaymentReceipt = (receipt) => { printed.push({document:"receipt", receipt}); };
    // The statement's void and refund controls are bound by their own function, tested by its own
    // spec, and are never rendered here because this actor may not correct a payment.
    const bindReceiptActions = () => {};
  `;
  const exported = `return {
    invoiceWorkspaceMarkup, invoiceDocumentActionsMarkup, invoiceSettlementPanelMarkup,
    invoiceVisitFactsMarkup, bindInvoiceWorkspace, printed
  };`;
  const factory = new Function(
    "escape",
    "escapeAttr",
    [prelude, GATES, REFUNDS, RENDERERS, LIFECYCLE_TIMES, LIFECYCLE_VALUES, DURATION, STAMP,
      WORKSPACE, exported].join("\n")
  ) as (escape: unknown, escapeAttr: unknown) => ClientModule;
  return factory(escape, escapeAttr);
}

/**
 * A fake host over one rendered workspace, so the real bindings can be run against it.
 *
 * `querySelector` answers for a test id ONLY when that id is in the markup it was handed, which is
 * the property most of these tests turn on: a control the workspace did not draw cannot be bound,
 * and a handler that was never bound cannot print.
 */
function bindWorkspace(client: ClientModule, markup: string): Record<string, () => void> {
  const handlers: Record<string, () => void> = {};
  client.bindInvoiceWorkspace(
    {
      querySelector(selector: string) {
        const id = /data-testid="([^"]+)"/u.exec(selector)?.[1];
        if (!id || !markup.includes(`data-testid="${id}"`)) return null;
        return {
          addEventListener(event: string, handler: () => void) {
            if (event === "click") handlers[id] = handler;
          }
        };
      },
      querySelectorAll: () => []
    },
    {}
  );
  return handlers;
}

type Payment = Record<string, unknown>;

/** A recorded cash component: everything a manual settlement has, and nothing a processor adds. */
function cashPayment(overrides: Payment = {}): Payment {
  return {
    id: "8f1c2ade-0000-4000-8000-000000000001",
    status: "recorded",
    method: "cash",
    amountMinor: 4000,
    recordedAt: "2026-09-02T19:30:00.000Z",
    provider: null,
    providerPaymentId: null,
    // The operator's free text. It may reach the client on the projection; no document draws it.
    externalReference: "till drawer 3 — card ending 4242",
    ...overrides
  };
}

/** The `GET /api/invoices/:id/receipt` payload, settled unless a test says otherwise. */
function receiptFixture(payments: Payment[], invoice: Record<string, unknown> = {}) {
  const settled = payments
    .filter((payment) => payment.status === "recorded")
    .reduce((total, payment) => total + Number(payment.amountMinor ?? 0), 0);
  return {
    invoice: {
      invoiceNumber: 1042,
      firstName: "Emma",
      lastName: "Johnson",
      businessName: "Riverside Grooming",
      businessPhone: "626-555-0101",
      businessEmail: "hello@riverside.example",
      locationAddress: "18 Mill Lane, Riverside",
      appointmentId: "ed2dd1b0-6c58-4a92-9a4f-0b6d9ee7c111",
      createdAt: "2026-09-02T18:00:00.000Z",
      subtotalMinor: 8500,
      discountMinor: 0,
      taxMinor: 701,
      tipMinor: 0,
      totalMinor: 9201,
      balanceMinor: Math.max(0, 9201 - settled),
      status: settled >= 9201 ? "paid" : settled ? "partially_paid" : "open",
      ...invoice
    },
    items: [{ description: "Full Groom", amountMinor: 8500 }],
    discounts: [],
    payments,
    refunds: [],
    refundedMinor: 0
  };
}

/** The appointment behind the invoice, as `GET /api/appointments/:id` returns it. */
function appointmentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "ed2dd1b0-6c58-4a92-9a4f-0b6d9ee7c111",
    petName: "Bailey",
    checkedInAt: "2026-09-02T16:16:00.000Z",
    checkedOutAt: "2026-09-02T17:23:00.000Z",
    ...overrides
  };
}

/**
 * One element of the rendered markup, whole, found by its test id.
 *
 * Depth-counted rather than matched with a lazy regex, because several of the things asserted
 * below are a LABEL AND A FIGURE in one row - `<span>Total settled</span><strong>$92.01</strong>`
 * - and a lazy match stops at the first close tag, which would read the label and silently drop
 * the money beside it.
 */
function element(markup: string, testid: string): string | null {
  const at = markup.indexOf(`data-testid="${testid}"`);
  if (at < 0) return null;
  const open = markup.lastIndexOf("<", at);
  const tag = /^<([a-z0-9]+)/u.exec(markup.slice(open))?.[1];
  if (!tag) return null;
  const scan = new RegExp(`</?${tag}\\b`, "gu");
  scan.lastIndex = open;
  let depth = 0;
  let match = scan.exec(markup);
  while (match) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return markup.slice(open, markup.indexOf(">", scan.lastIndex) + 1);
    match = scan.exec(markup);
  }
  return null;
}

/** That element's text, tags stripped, or null when it was not drawn at all. */
function value(markup: string, testid: string): string | null {
  const node = element(markup, testid);
  return node === null ? null : node.replaceAll(/<[^>]+>/gu, "").trim();
}

/** The workspace's own heading — what the document calls itself. */
function title(markup: string): string {
  return value(markup, "invoice-document-title") ?? "";
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The document, and what it calls itself.
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("the workspace is an Invoice in every settlement state", () => {
  it("heads itself Invoice #N unpaid, part-paid and settled alike", () => {
    const client = loadClient();
    for (const [label, receipt] of [
      ["nothing paid", receiptFixture([])],
      ["in progress", receiptFixture([cashPayment()])],
      ["settled", receiptFixture([cashPayment({ amountMinor: 9201 })])]
    ] as [string, ReturnType<typeof receiptFixture>][]) {
      const markup = client.invoiceWorkspaceMarkup(receipt, null);
      expect(title(markup), label).toBe("Invoice #1042");
      // The Receipt is a different document with a different subject and is never on this surface.
      expect(markup, label).not.toContain('data-testid="payment-receipt"');
      expect(markup, label).not.toContain("Receipt #1042");
    }
  });

  /**
   * THE NUMBER AND THE STATE ARE ONE LINE: `Invoice #12101807   Paid`.
   *
   * The chip used to sit in a `<p class="invoice-head-meta">` of its own UNDER the <h2>, which
   * spent a whole row of the head to say one word - and the head sits directly above the money
   * statement, so that was the most expensive vertical space on the surface. Identity and current
   * state are the two things a document's head is for and they belong on one line.
   *
   * The WRAP at a narrow width is layout and belongs to `tests/e2e/invoice-workspace.spec.ts`,
   * which measures it at 360px. What is deterministic here is the SHAPE: one row, two siblings,
   * the existing chip, and the chip outside the heading.
   */
  it("puts the state on the SAME LINE as the number, not on a row of its own", () => {
    const client = loadClient();
    const markup = client.invoiceWorkspaceMarkup(
      receiptFixture([cashPayment({ amountMinor: 9201 })]), null
    );

    expect(markup).toContain('class="surface-head-text invoice-head-identity"');
    // The separate meta row is gone rather than hidden, so nothing is left to drift back.
    expect(markup).not.toContain("invoice-head-meta");
    // Siblings, in that order, with nothing between them: the chip follows the number's heading
    // directly inside the one row.
    expect(markup).toContain(
      '<h2 id="invoice-surface-title" data-testid="invoice-document-title">Invoice #1042</h2>'
      + '<span class="badge invoice-status-badge" data-testid="invoice-status">Paid</span>'
    );

    // AND THE CHIP IS OUTSIDE THE <h2>. The heading is the surface's `aria-labelledby`, so a state
    // folded into it would rename the document every time the invoice was paid.
    expect(title(markup)).toBe("Invoice #1042");
    expect(title(markup)).not.toContain("Paid");
  });

  it("moves the existing chip rather than introducing a second status component", () => {
    // `.badge` is the product's chip and `.invoice-status-badge` is its one tint on this surface.
    // Putting the state on the title's line was a LAYOUT change; a new component or a new colour
    // would have been a different change wearing this one's description.
    const client = loadClient();
    const markup = client.invoiceWorkspaceMarkup(receiptFixture([]), null);
    expect(markup)
      .toContain('<span class="badge invoice-status-badge" data-testid="invoice-status">');
    expect([...markup.matchAll(/data-testid="invoice-status"/gu)]).toHaveLength(1);
  });

  it("says which settlement state it is in, beside the name and never instead of it", () => {
    const client = loadClient();
    expect(value(client.invoiceWorkspaceMarkup(receiptFixture([]), null), "invoice-status"))
      .toBe("Open");
    expect(value(
      client.invoiceWorkspaceMarkup(receiptFixture([cashPayment()]), null), "invoice-status"
    )).toBe("Partially paid");
    expect(value(
      client.invoiceWorkspaceMarkup(receiptFixture([cashPayment({ amountMinor: 9201 })]), null),
      "invoice-status"
    )).toBe("Paid");
  });

  it("hosts the SHARED money statement rather than a second reading of the same invoice", () => {
    // The one change this conversion was not allowed to make. `receiptBodyMarkup` is drawn into
    // the print root and into a settled Check Out as well; a workspace that itemised the visit
    // itself would be a second opinion about one bill, and the two would drift.
    const client = loadClient();
    const receipt = receiptFixture([cashPayment({ amountMinor: 9201 })]);
    const markup = client.invoiceWorkspaceMarkup(receipt, null);

    expect(markup).toContain('data-testid="receipt"');
    // Every money line on the surface comes from that statement — there is exactly one of it, and
    // exactly one of each figure it draws.
    expect(markup.match(/data-testid="receipt"/gu)).toHaveLength(1);
    expect(markup.match(/Full Groom/gu)).toHaveLength(1);
    // `Service subtotal`, and there is exactly one of it. The generic `Subtotal` is gone from the
    // statement entirely: a row reading `Subtotal $85.00` directly above one reading `Total
    // $85.00` was one figure under two names.
    expect(markup.match(/>Service subtotal</gu)).toHaveLength(1);
    expect(markup).not.toMatch(/>Subtotal</u);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The footer: two documents, two controls, and two capabilities that do not exist.
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("the footer offers the documents that exist and refuses the ones that do not", () => {
  it("keeps Print Invoice after settlement and adds Print Receipt beside it", () => {
    const client = loadClient();
    const settled = client.invoiceWorkspaceMarkup(
      receiptFixture([cashPayment({ amountMinor: 9201 })]), null
    );
    const handlers = bindWorkspace(client, settled);

    // Two documents, two controls, neither excluding the other. An invoice is printable in every
    // settlement state and a client may still ask for the bill after paying it.
    expect(Object.keys(handlers).sort()).toEqual(["invoice-print-invoice", "invoice-print-receipt"]);
    handlers["invoice-print-invoice"]!();
    handlers["invoice-print-receipt"]!();
    expect(client.printed.map((entry) => entry.document)).toEqual(["invoice", "receipt"]);
  });

  it("withholds the Receipt while a settlement is still in progress", () => {
    // A recorded component against an invoice that still owes money is a settlement that has not
    // finished. Absent rather than disabled: there is no document to disable.
    const client = loadClient();
    const markup = client.invoiceWorkspaceMarkup(receiptFixture([cashPayment()]), null);
    expect(Object.keys(bindWorkspace(client, markup))).toEqual(["invoice-print-invoice"]);
    expect(markup).not.toContain('data-testid="invoice-print-receipt"');
  });

  it("withholds the Receipt from a ZERO-TOTAL invoice that settled nothing", () => {
    // THE CASE THE TWO GATES EXIST SEPARATELY FOR. The server creates a $0.00 visit's invoice with
    // status `paid` and `balance_minor = 0` and NO payment rows at all. Balance alone would pass
    // it — nothing is owed — and it must not: there is no settlement to evidence. Print Invoice is
    // still offered, because the visit still has a bill.
    const client = loadClient();
    const markup = client.invoiceWorkspaceMarkup(
      receiptFixture([], { totalMinor: 0, subtotalMinor: 0, taxMinor: 0, balanceMinor: 0,
        status: "paid" }),
      null
    );
    expect(Object.keys(bindWorkspace(client, markup))).toEqual(["invoice-print-invoice"]);
    expect(markup).not.toContain('data-testid="invoice-print-receipt"');
    // And it says so honestly rather than claiming a completed settlement.
    expect(value(markup, "invoice-state-title")).toBe("Nothing to settle");
  });

  it("draws Send Receipt and Ask for Review DISABLED, with a reason, bound to nothing", () => {
    // Neither capability exists in Pawsh yet: no route, no template, no delivery record, and no
    // notification type. Both are planned. The standing rule is that an unavailable capability is
    // disabled rather than hidden, so an operator looking for how to send a receipt finds the
    // control saying it is not built yet instead of hunting a screen that silently omits it.
    const client = loadClient();
    const markup = client.invoiceWorkspaceMarkup(
      receiptFixture([cashPayment({ amountMinor: 9201 })]), null
    );
    const handlers = bindWorkspace(client, markup);

    for (const testid of ["invoice-send-receipt", "invoice-ask-review"]) {
      const control = element(markup, testid);
      expect(control, testid).not.toBeNull();
      expect(control!, testid).toContain("disabled");
      expect(control!, testid).toContain('aria-disabled="true"');
      // A `title` alone is unreachable from a keyboard and unreadable on a phone, so it is not
      // the reason — it is a second copy of it.
      expect(control!, testid).toContain("title=");
      // NOTHING IS WIRED TO EITHER. A disabled attribute is a fact about a DOM node; a handler
      // that does not exist is a fact about the product.
      expect(handlers[testid], testid).toBeUndefined();
    }

    // The reason itself, on screen and not only in a tooltip, said once for the pair. The same
    // sentence is on both controls' `title`, so the two copies cannot drift.
    const note = value(markup, "invoice-unavailable-note")!;
    expect(element(markup, "invoice-send-receipt")).toContain(note.slice(0, 40));

    // ─── WHAT THE SENTENCE HAS TO MEAN ──────────────────────────────────────────────────────
    //
    // A STATE OF THE PRODUCT, NOT OF THE ACTOR AND NOT OF THIS INVOICE. Three controls on and
    // around this footer are unavailable for three different reasons and their sentences must
    // not blur together: Print Receipt is absent because THIS INVOICE has no completed
    // settlement; the Invoice control on the appointment footer is disabled because THIS ACTOR
    // lacks `payments.view`; and these two are disabled because THE PRODUCT has not built them
    // yet. An operator told "you do not have permission" would go and ask an owner for a role
    // that would not help them; one told it was unavailable for this invoice would try another.
    //
    // Matched on meaning rather than on an exact string, so rewording the sentence is free and
    // changing what it CLAIMS is not.
    expect(note, "says it does not exist YET").toMatch(/\byet\b/iu);
    expect(note, "says it is coming").toMatch(/planned|coming|later release/iu);
    expect(note, "says it is true for everyone").toMatch(/nobody|anyone|any invoice|no one/iu);
    // NEVER the vocabulary of a refusal or of a missing permission.
    expect(note, "is not a permission message")
      .not.toMatch(/permission|not allowed|access denied|your role|contact an owner/iu);
    // NEVER a claim about this one invoice.
    expect(note, "is not a claim about this invoice")
      .not.toMatch(/for this invoice|on this invoice|this invoice cannot/iu);
    // And it says what the operator CAN do instead, which is the whole point of drawing it.
    expect(note).toContain("Print the Receipt");
  });

  it("presses Print Receipt and gets the Receipt, never the Ticket", () => {
    const client = loadClient();
    const receipt = receiptFixture([cashPayment({ amountMinor: 9201 })]);
    bindWorkspace(client, client.invoiceWorkspaceMarkup(receipt, null))["invoice-print-receipt"]!();
    expect(client.printed).toEqual([{ document: "receipt", receipt: {} }]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The right-hand column: where this invoice stands.
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("the settlement summary reads through the shared figures and never renames them", () => {
  it("names the state in words for each of the four cases", () => {
    const client = loadClient();
    const state = (receipt: unknown) =>
      value(client.invoiceSettlementPanelMarkup(receipt), "invoice-state-title");

    expect(state(receiptFixture([]))).toBe("Not yet settled");
    expect(state(receiptFixture([cashPayment()]))).toBe("Settlement in progress");
    expect(state(receiptFixture([cashPayment({ amountMinor: 9201 })])))
      .toBe("Settlement complete");
    expect(state(receiptFixture([], { totalMinor: 0, balanceMinor: 0, status: "paid" })))
      .toBe("Nothing to settle");
  });

  it("says Total settled — never Total paid, and never a numbered series of payments", () => {
    // ONE INVOICE, ONE COMPLETED SETTLEMENT, SEVERAL TENDER COMPONENTS. "Payment 1 of 2" framed one
    // settlement as two independent checkouts; "Total paid" claims a collection that a client
    // credit component never made.
    const client = loadClient();
    const markup = client.invoiceSettlementPanelMarkup(receiptFixture([
      cashPayment({ method: "client_credit", amountMinor: 4000 }),
      cashPayment({ id: "8f1c2ade-0000-4000-8000-000000000002", amountMinor: 5201 })
    ]));

    expect(value(markup, "invoice-summary-settled")).toBe("Total settled$92.01");
    expect(markup).not.toContain("Total paid");
    expect(markup).not.toMatch(/Payment \d+ of/u);
  });

  it("draws no settled line at all against an invoice nothing has been tendered on", () => {
    // A permanent "Total settled $0.00" beside an untouched bill reads as a settlement of nothing
    // rather than as no settlement.
    const client = loadClient();
    const markup = client.invoiceSettlementPanelMarkup(receiptFixture([]));
    expect(markup).not.toContain('data-testid="invoice-summary-settled"');
    expect(value(markup, "invoice-summary-total")).toBe("Invoice total$92.01");
    expect(value(markup, "invoice-summary-balance")).toBe("Balance$92.01");
  });

  it("shows what went back only when something did", () => {
    const client = loadClient();
    const clean = client.invoiceSettlementPanelMarkup(
      receiptFixture([cashPayment({ amountMinor: 9201 })])
    );
    expect(clean).not.toContain('data-testid="invoice-summary-refunded"');

    const refunded = receiptFixture([cashPayment({ amountMinor: 9201 })]);
    refunded.refundedMinor = 1000;
    expect(value(client.invoiceSettlementPanelMarkup(refunded), "invoice-summary-refunded"))
      .toBe("Refunded-$10.00");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The left-hand column: the visit, above the money.
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("the visit facts are drawn from what the surface can actually see", () => {
  it("always states the client and the invoice date, which the financial payload carries", () => {
    const client = loadClient();
    const markup = client.invoiceVisitFactsMarkup(receiptFixture([]), null);
    expect(value(markup, "invoice-fact-client")).toBe("Emma Johnson");
    // Through the preference layer, never `Intl` and never a hard-coded MM/DD/YYYY.
    expect(value(markup, "invoice-fact-date")).toBe("«date» 2026-09-02");
  });

  it("draws NO lifecycle rows at all until the appointment behind the invoice has been read", () => {
    // ABSENT IS NOT THE SAME CLAIM AS "NOT RECORDED". `GET /api/invoices/:id/receipt` carries no
    // lifecycle, so the workspace opens without one and reads the appointment separately — and an
    // operator whose actor may not read appointments, or whose read failed, must not be told the
    // visit has no check-in time.
    const client = loadClient();
    const markup = client.invoiceVisitFactsMarkup(receiptFixture([]), null);
    for (const absent of [
      "invoice-fact-pet", "invoice-fact-checked-in", "invoice-fact-checked-out",
      "invoice-fact-duration"
    ]) {
      expect(markup, absent).not.toContain(`data-testid="${absent}"`);
    }
    expect(markup).not.toContain("not recorded");
  });

  it("states the times and the duration once the appointment has landed", () => {
    const client = loadClient();
    const markup = client.invoiceVisitFactsMarkup(receiptFixture([]), appointmentFixture());
    expect(value(markup, "invoice-fact-pet")).toBe("Bailey");
    expect(value(markup, "invoice-fact-checked-in")).toContain(PREFERRED_STAMP);
    expect(value(markup, "invoice-fact-checked-out")).toContain(PREFERRED_STAMP);
    // 16:16 to 17:23 is an hour and seven minutes, said the way an operator says it.
    expect(value(markup, "invoice-fact-duration")).toBe("1 h 7 m");
  });

  it("says not recorded, set back, for a visit that genuinely has no times", () => {
    const client = loadClient();
    const markup = client.invoiceVisitFactsMarkup(
      receiptFixture([]), appointmentFixture({ checkedInAt: null, checkedOutAt: null })
    );
    expect(value(markup, "invoice-fact-checked-in")).toBe("not recorded");
    expect(value(markup, "invoice-fact-duration")).toBe("not recorded");
    expect(markup).toContain('class="is-unrecorded"');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The operator's free text is never on this surface.
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("externalReference reaches no document, the workspace included", () => {
  it("never renders it, in any settlement state", () => {
    // `payments.external_reference` is unconstrained free text an operator types — up to 200
    // characters, a card number included — and the Receipt deliberately refuses to print it. The
    // workspace is a fourth place it could have leaked into, and it does not.
    const client = loadClient();
    for (const receipt of [
      receiptFixture([cashPayment()]),
      receiptFixture([cashPayment({ amountMinor: 9201 })]),
      receiptFixture([cashPayment({ status: "voided" })])
    ]) {
      const markup = client.invoiceWorkspaceMarkup(receipt, appointmentFixture());
      expect(markup).not.toContain("till drawer 3");
      expect(markup).not.toContain("4242");
      expect(markup).not.toContain("externalReference");
      expect(markup).not.toContain("Processor reference");
    }
  });
});
