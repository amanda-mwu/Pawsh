import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE RECEIPT IS ITS OWN DOCUMENT, IT EVIDENCES ONE COMPLETED SETTLEMENT, AND EVERY FACT ON IT IS
 * ONE THE LEDGER HOLDS.
 *
 * Pawsh has four artifacts and only one of them is evidence of payment:
 *
 *   Ticket   the shop's work sheet for the visit. Carries no money at all.
 *   Invoice  what the visit cost and what is still owed. `receiptBodyMarkup`.
 *   Payment  ONE TENDER COMPONENT of a settlement against one invoice.
 *   Receipt  evidence of the COMPLETED SETTLEMENT. `paymentReceiptMarkup`, tested here.
 *
 * ONE INVOICE PER APPOINTMENT. ONE COMPLETED SETTLEMENT PER INVOICE. A SETTLEMENT MAY USE SEVERAL
 * TENDER COMPONENTS. $40.00 of client credit and $52.01 on a card is ONE settlement paid two ways,
 * and the `payments` rows behind it are components of it — never independent checkout events, and
 * never a series the client is asked to count through.
 *
 * ─── WHY THIS FILE EXECUTES RATHER THAN GREPS ────────────────────────────────────────────────
 *
 * Four high-stakes behaviours used to be "protected" by whitespace-exact source-literal
 * assertions: this file asserted that `public/app.js` CONTAINED the string
 * `"function printPaymentReceipt(receipt){\n  if(!receiptHasPayment(receipt))return;"`, two spaces
 * of indentation included. That test could not fail for the reason it existed. Nothing anywhere
 * invoked `printPaymentReceipt` with a paymentless receipt, so deleting the guard broke no test at
 * all — the literal assertion would have failed only if somebody REFORMATTED the guard, and would
 * have passed happily while the guard's body did the wrong thing.
 *
 * Every assertion below therefore CALLS the client's own functions. The four behaviours each have
 * a stated mutation that makes them fail:
 *
 *   1. a paymentless Invoice cannot produce a Receipt  — remove the `receiptHasPayment` guard
 *   2. a settled Invoice still exposes Print Invoice   — restore the mutually-exclusive footer
 *   3. Print Receipt is a separate independent control — as above, from the other side
 *   4. Print Receipt renders the Receipt, not a Ticket — wire its handler to `printTicket`
 *
 * ─── THE HARNESS ────────────────────────────────────────────────────────────────────────────
 *
 * `public/app.js` is served as a plain module with no bundler and has top-level side effects that
 * need a document, so the regions under test are sliced out by their own declarations and
 * evaluated against stubs — the harness `tests/ui/receipt-salon-identity.test.ts` and
 * `tests/ui/business-settings.test.ts` already use, widened to cover the print path and the
 * checkout footer.
 *
 * The DOM stub is deliberately tiny and exact. `printFinancialRoot` and `printTicket` compose a
 * document and hand it to `appendPrintRoot`, which only ever creates a section, sets `className`
 * and `innerHTML`, appends it and calls `print()`, so a recording `document` reproduces the whole
 * of what they do. `querySelector` is stubbed to answer for a test id ONLY when that id is present
 * in the markup it was handed — which is the property the footer tests turn on: a control that was
 * not rendered cannot be bound, and a handler that was never bound cannot print.
 *
 * BETWEEN THE TWO NOW SITS THE PREVIEW, and this file's stub of it CONFIRMS IMMEDIATELY. Every
 * question below is about WHICH DOCUMENT reaches paper — an Invoice, a Receipt, never a Ticket,
 * never a Receipt for a settlement that did not complete — and inserting a click into thirty
 * assertions would not sharpen one of them. That the preview happens at all, that dismissing it
 * prints nothing, and that Print is the only thing that reaches `appendPrintRoot`, is
 * `tests/ui/print-preview.test.ts`. The previews are still recorded here, so a document that
 * skipped the preview entirely would show up as a missing record rather than as nothing.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────
 *
 * The two gates are independently sensitive, and these kill one each AT THE CHECK OUT FOOTER —
 * the place an operator actually meets the decision, and the place neither was being asked:
 *
 *   `&&!receipt?.refundedMinor` added to `receiptSettlementComplete`
 *       the Receipt leaves every refunded invoice silently. "walks the settlement ladder, and a
 *       REFUND does not take the Receipt back off it" fails on both refunded rungs, and "prints
 *       that settlement when the refunded surface's own control is pressed" fails with no
 *       control left to press.
 *
 *   dropping `receiptHasPayment(receipt)&&` from `receiptSettlementComplete`, or asking the
 *   footer's own condition `!receiptBalanceOutstanding(receipt)` instead of both gates
 *       the balance decides alone, and the $0.00 visit — raised Paid, nothing owed, no payment
 *       row ever written — is handed evidence of a settlement that never happened. "is ABSENT on
 *       the $0.00 visit's Check Out footer, which is Paid with no payment rows at all" fails.
 *       The footer-scoped form is the one nothing else in this file catches: with it applied,
 *       that test is the ONLY failure in the file.
 *
 * The other half of the first gate — `receiptHasPayment` weakened to
 * `(receipt?.payments||[]).length>0` — is killed by "prints NOTHING for a voided-only record
 * with NOTHING OWED" below. It cannot reach the $0.00 visit, whose payments array is empty under
 * that mutation as well as under the real filter; only the balance-only mutation above reaches
 * that one.
 *
 * All three were applied to `public/app.js`, run against this file, and reverted; the file was
 * verified byte-identical by hash afterwards.
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

/** The two gates and the two document titles, which decide which document is which. */
const GATES = slice("function receiptHasPayment(", "\nfunction toast(");
/** `build` / `collect` / `settled`, which the footer and the progress line both read. */
const MODE = slice("function checkoutMode(co){", "\n/**\n * What the bill will come to");
/** The print mechanism and the two documents that go through it. */
const PRINT = slice("function printFinancialRoot(", "\nfunction checkoutDisclosureMarkup(");
/** The settlement-in-progress line on the Check Out surface. */
const PROGRESS = slice(
  "function checkoutSettlementProgressMarkup(co){",
  "\nfunction checkoutMoneyMarkup("
);
/** The Check Out surface, whose footer carries the two print controls. */
const SURFACE = slice("function checkoutSurfaceMarkup(co){", "\nasync function checkout(id)");
/** Refunds read off the receipt, which is how a refund keeps its component. */
const REFUNDS = slice("function receiptRefundsFor(", "\nfunction salonIdentityOf(");
/** The salon identity header, the Invoice's body and the Receipt. */
const RENDERERS = slice(
  "function salonIdentityOf(",
  "\n// Scoped to the copy of the receipt that was just rendered"
);
/**
 * The Invoice workspace: its footer controls, its visit facts, its settlement panel, the shell
 * that holds them, and the bindings that make its two print controls print.
 *
 * `showInvoiceDocument` itself is NOT in this slice. It is surface plumbing - a stack level, a
 * focus policy, a `receiptHost` claim and the appointment read behind the visit facts - and none
 * of that decides which document a control produces. What does is `invoiceWorkspaceMarkup` and
 * `bindInvoiceWorkspace`, both of which are in here and both of which are run.
 */
const DOCUMENT_ACTIONS = slice(
  "const INVOICE_UNAVAILABLE_REASON=",
  "\n/**\n * Opens the Invoice workspace"
);
/** The Ticket's own print path, so "never the Ticket" is asserted against the real function. */
const TICKET_PRINT = slice("function printTicket(item,notes){", "\n/**\n * Opens the Ticket.");
/**
 * The two print handlers from inside `checkout()`'s `bind`, lifted out by their own comment
 * anchors. `checkout()` is a 250-line async closure over a live dialog and a stack level; the
 * WIRING is what these tests are about, and this is the wiring, verbatim.
 */
const PRINT_BINDINGS = slice(
  "    // ONE BUTTON, ONE DOCUMENT.",
  "    // NO RECEIPT IS HANDED UP."
);

/** The stub's output, distinctive enough that a raw `Intl` call could not produce it by accident. */
const PREFERRED_STAMP = "«preference-layer stamp»";
/** What `printTicket` would put on paper. Nothing financial may ever produce it. */
const TICKET_SENTINEL = '<div data-testid="ticket-document">«the shop’s work sheet»</div>';

interface PrintedRoot {
  className: string;
  innerHTML: string;
}

interface ModalRecord {
  title: string;
  body: string;
}

interface ClientModule {
  receiptHasPayment(receipt: unknown): boolean;
  receiptSettlementComplete(receipt: unknown): boolean;
  invoiceDocumentTitle(receipt: unknown): string;
  paymentReceiptTitle(receipt: unknown): string;
  paymentReceiptMarkup(receipt: unknown): string;
  receiptBodyMarkup(receipt: unknown): string;
  checkoutMode(co: unknown): string;
  checkoutSurfaceMarkup(co: unknown): string;
  checkoutSettlementProgressMarkup(co: unknown): string;
  invoiceDocumentActionsMarkup(receipt: unknown): string;
  printInvoiceDocument(receipt: unknown): void;
  printPaymentReceipt(receipt: unknown): void;
  printTicket(item: unknown, notes: unknown): void;
  invoiceWorkspaceMarkup(receipt: unknown, appointment: unknown): string;
  openInvoiceWorkspace(receipt: unknown): void;
  bindCheckoutPrintControls(dialog: unknown, co: unknown): void;
  /** Every `.print-root` the client appended to the body, in order. */
  printed: PrintedRoot[];
  /** How many times the client asked the browser to print. */
  prints: { count: number };
  /** Every print preview the client opened, in order. */
  previews: { title: string; body: string; confirmLabel: string; dismissLabel: string }[];
  /** The last Invoice workspace rendered, and the handlers bound into it. */
  modal: ModalRecord;
  modalHandlers: Record<string, () => void>;
}

function loadClient(options: { money?: string } = {}): ClientModule {
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const escapeAttr = (value = "") => escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const prelude = `
    "use strict";
    const money = ${options.money ?? '(minor) => "$" + (Number(minor || 0) / 100).toFixed(2)'};
    const clientName = (record) =>
      [record.firstName, record.lastName].filter(Boolean).join(" ").trim() || "Not set";
    // The cashier who cannot correct a payment. Void and Refund controls are the Invoice's, they
    // are hidden from print anyway, and none of them is what this file is about.
    const allowed = () => false;
    // Mirrors PAYMENT_METHOD_LABELS, which lives above the slices.
    const paymentMethodLabel = (method) =>
      ({cash:"Cash",external_card:"Card",check:"Check",other:"Other",client_credit:"Client credit"})[method]
        || String(method || "").replaceAll("_", " ");
    // THE PREFERENCE LAYER, STUBBED SO ITS ABSENCE WOULD SHOW. If a renderer ever formats a stamp
    // itself — through Intl, through toLocaleString, through anything — the sentinel stops
    // appearing and the assertions below fail rather than quietly reading the runner's locale.
    const formatPrefDateAndTime = (instant) => ${JSON.stringify(PREFERRED_STAMP)} + " " + instant.toISOString();
    const formatPrefDate = (instant) => instant.toISOString().slice(0, 10);
    const taxPayPercent = (basisPoints) => (Number(basisPoints || 0) / 100).toFixed(2);

    // WHAT THE TICKET WOULD PUT ON PAPER. \`ticketDocumentMarkup\` is a 200-line CRM renderer far
    // outside these slices; what matters here is that no financial control can ever reach it, so
    // it is a sentinel and \`printTicket\` itself is the real function.
    const ticketDocumentMarkup = () => ${JSON.stringify(TICKET_SENTINEL)};
    // The bill and the money form. Their contents are held by their own specs; the footer under
    // them is what this file drives, so they are named rather than rendered.
    const checkoutBillMarkup = () => "<!--bill-->";
    const checkoutMoneyMarkup = (co) =>
      "<!--money-->" + (checkoutMode(co) === "settled" ? receiptBodyMarkup(co.receipt) : checkoutSettlementProgressMarkup(co));
    const appointmentPresentation = () => ({dateLabel:"Wed 2 Sep"});
    // Mirrors INVOICE_STATUS_LABELS, which lives above the slices.
    const invoiceStatusLabel = (status) =>
      ({draft:"Draft",open:"Open",partially_paid:"Partially paid",paid:"Paid",
        partially_refunded:"Partly refunded",refunded:"Refunded",void:"Void"})[status]
        || String(status || "").replaceAll("_", " ");
    // The Ticket's own reference, which its print PREVIEW is now titled by. Eight hex characters
    // in the client, and the same eight here.
    const ticketReference = (item) => String(item.id).slice(0, 8);

    // THE DOM, recorded rather than emulated. Both print paths do exactly four things to it.
    const printed = [];
    const prints = {count:0};
    const document = {
      createElement:() => ({className:"",innerHTML:"",remove(){}}),
      body:{append(node){printed.push(node);}}
    };
    const globalThis = {print(){prints.count += 1;}};
    // The 1000ms tidy-up is a browser concern; a real timer here would outlive the test run.
    const setTimeout = () => 0;

    // The shared modal, recorded the same way. \`querySelector\` answers for a test id ONLY when
    // that id is in the markup the dialog was handed — a control that was not rendered cannot be
    // bound, which is the property the footer tests turn on.
    const modal = {title:"",body:""};
    const modalHandlers = {};
    const queryHost = (markup, handlers) => ({
      querySelector(selector){
        const id = /data-testid="([^"]+)"/u.exec(selector)?.[1];
        if(!id || !markup().includes(\`data-testid="\${id}"\`)) return null;
        return {addEventListener(event, handler){ if(event === "click") handlers[id] = handler; }};
      }
    });
    const openModal = (title, body) => { modal.title = title; modal.body = body; };
    // THE INVOICE WORKSPACE, RENDERED AND BOUND, WITHOUT ITS SURFACE.
    //
    // \`showInvoiceDocument\` opens a <dialog> on the surface stack, claims
    // \`receiptHost\` and reads the appointment behind the invoice. None of that
    // decides which document a control produces. This renders the very markup that surface
    // renders and runs the very bindings it runs, so a control the workspace did not draw is
    // still a control that cannot be bound and cannot print. A null appointment is the state the
    // workspace opens in at every door: the visit facts arrive later, and no money line and no
    // print control depends on them.
    const openInvoiceWorkspace = (receipt) => {
      modal.body = invoiceWorkspaceMarkup(receipt, null);
      for(const key of Object.keys(modalHandlers)) delete modalHandlers[key];
      bindInvoiceWorkspace(queryHost(() => modal.body, modalHandlers), receipt);
    };
    // The preview, recorded and then confirmed. See the header note: this file is about which
    // document reaches paper, and \`tests/ui/print-preview.test.ts\` is about the step itself.
    const previews = [];
    const openStackedDialog = (options) => {
      previews.push({title:options.title, body:options.body,
        confirmLabel:options.confirmLabel, dismissLabel:options.dismissLabel});
      options.onConfirm();
      return null;
    };
    const $ = () => queryHost(() => modal.body, modalHandlers);
    // The Invoice's own corrections are bound by their own function and tested by their own spec.
    const bindReceiptActions = () => {};

    // The two print handlers out of \`checkout()\`'s bind, given the two things they close over.
    function bindCheckoutPrintControls(dialog, co){
${PRINT_BINDINGS}
    }
  `;
  const exported = `return {
    receiptHasPayment, receiptSettlementComplete, invoiceDocumentTitle, paymentReceiptTitle,
    paymentReceiptMarkup, receiptBodyMarkup, checkoutMode, checkoutSurfaceMarkup,
    checkoutSettlementProgressMarkup, invoiceDocumentActionsMarkup, printInvoiceDocument,
    printPaymentReceipt, printTicket, invoiceWorkspaceMarkup, openInvoiceWorkspace,
    bindCheckoutPrintControls,
    printed, prints, previews, modal, modalHandlers
  };`;
  const factory = new Function(
    "escape",
    "escapeAttr",
    [prelude, GATES, MODE, PRINT, PROGRESS, SURFACE, REFUNDS, RENDERERS, DOCUMENT_ACTIONS,
      TICKET_PRINT, exported].join("\n")
  ) as (escape: unknown, escapeAttr: unknown) => ClientModule;
  return factory(escape, escapeAttr);
}

/**
 * A fake Check Out dialog over one rendered surface, so the real bindings can be run against it.
 *
 * The handlers map is what a click reaches. A control the footer did not render is not in it,
 * which is exactly how "there is no Receipt to print" is asserted as behaviour rather than as an
 * absent string.
 */
function bindSurface(client: ClientModule, co: unknown): Record<string, () => void> {
  const markup = client.checkoutSurfaceMarkup(co);
  const handlers: Record<string, () => void> = {};
  client.bindCheckoutPrintControls(
    {
      querySelector(selector: string) {
        const id = /data-testid="([^"]+)"/u.exec(selector)?.[1];
        if (!id || !markup.includes(`data-testid="${id}"`)) return null;
        return {
          addEventListener(event: string, handler: () => void) {
            if (event === "click") handlers[id] = handler;
          }
        };
      }
    },
    co
  );
  return handlers;
}

type Payment = Record<string, unknown>;

/** A recorded cash payment: everything a manual settlement has, and nothing a processor adds. */
function cashPayment(overrides: Payment = {}): Payment {
  return {
    id: "8f1c2ade-0000-4000-8000-000000000001",
    status: "recorded",
    method: "cash",
    amountMinor: 4000,
    recordedAt: "2026-09-02T19:30:00.000Z",
    provider: null,
    providerPaymentId: null,
    externalReference: null,
    providerTipMinor: null,
    ...overrides
  };
}

/** A tender component taken from the client's own account balance. No money was collected. */
function creditPayment(overrides: Payment = {}): Payment {
  return cashPayment({
    id: "c1ed17aa-0000-4000-8000-000000000003",
    method: "client_credit",
    amountMinor: 4000,
    ...overrides
  });
}

/** A manually keyed card: the ledger's `external_card`, with no processor behind it. */
function keyedCardPayment(overrides: Payment = {}): Payment {
  return cashPayment({
    id: "ca2d0007-0000-4000-8000-000000000004",
    method: "external_card",
    amountMinor: 5201,
    recordedAt: "2026-09-02T19:31:00.000Z",
    ...overrides
  });
}

/** The Square shape the terminal route writes: a provider, its payment id and a reference. */
function terminalPayment(overrides: Payment = {}): Payment {
  return {
    id: "5b7d90cc-0000-4000-8000-000000000002",
    status: "recorded",
    method: "external_card",
    amountMinor: 6160,
    recordedAt: "2026-09-02T20:05:00.000Z",
    provider: "square",
    providerPaymentId: "sqpmt_9Rt4KvA1",
    externalReference: "pawsh-checkout-4417",
    providerTipMinor: 500,
    ...overrides
  };
}

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
      subtotalMinor: 8500,
      discountMinor: 0,
      taxMinor: 701,
      tipMinor: 0,
      totalMinor: 9201,
      // Settled by default, so a fixture has to SAY it is still owing to be treated as owing.
      balanceMinor: Math.max(0, 9201 - settled),
      // The two non-money invoice columns the workspace head and its visit facts read. Neither
      // is a figure and neither gates a document, and a fixture may override either.
      status: settled >= 9201 ? "paid" : settled ? "partially_paid" : "open",
      createdAt: "2026-09-02T18:00:00.000Z",
      ...invoice
    },
    items: [],
    discounts: [],
    payments,
    refunds: [],
    refundedMinor: 0
  };
}

/** The Check Out surface's state object, in the three modes `checkoutMode` distinguishes. */
function checkoutFixture(receipt: unknown) {
  return {
    appointment: { id: "3f9a0c11-0000-4000-8000-0000000000aa", firstName: "Emma", lastName: "Johnson" },
    receipt,
    terminals: [],
    creditAvailableMinor: 0,
    base: 8500
  };
}

/** Every `data-testid` on the document, in document order, so absence is asserted by name. */
function testids(markup: string): string[] {
  return [...markup.matchAll(/data-testid="([^"]+)"/gu)].map((match) => match[1]!);
}

/**
 * What the Invoice workspace CALLS ITSELF, read off its own heading.
 *
 * The document used to be titled by the dialog it was opened in, so a test could read the
 * title off the harness. It is a surface now and titles itself, which is stricter: this reads
 * the <h2> the surface is labelled by, so a workspace that renamed itself once something had
 * been paid would be caught by the same assertion that used to watch the dialog.
 */
function workspaceTitle(markup: string): string {
  return /data-testid="invoice-document-title">([^<]*)</u.exec(markup)?.[1] ?? "";
}

/**
 * The rendered value of one labelled line, or `null` when the line was not drawn at all.
 *
 * The whole row is matched rather than the value alone, so a label with an empty `<strong>` after
 * it cannot pass as an absent line.
 */
function lineValue(markup: string, testid: string): string | null {
  const pattern = new RegExp(
    `<div (?:class="[^"]*" )?data-testid="${testid}"><span>([^<]*)</span><strong>([^<]*)</strong></div>`,
    "u"
  );
  const match = pattern.exec(markup);
  return match ? `${match[1]} | ${match[2]}` : null;
}

/** The settlement's tender composition, as `method | amount` pairs in document order. */
function tenderLines(markup: string): string[] {
  return [
    ...markup.matchAll(
      /<div class="payment-receipt-tender" data-testid="payment-receipt-tender"><span>([^<]*)<\/span><strong>([^<]*)<\/strong><\/div>/gu
    )
  ].map((match) => `${match[1]} | ${match[2]}`);
}

/** The purchased lines of the settlement, as `description | amount` pairs in document order. */
function itemLines(markup: string): string[] {
  return [
    ...markup.matchAll(
      /<div class="payment-receipt-item" data-testid="payment-receipt-item"><span>([\s\S]*?)<\/span><strong>([^<]*)<\/strong><\/div>/gu
    )
    // The label may carry a `<small>` naming the pet, so it is read as markup and flattened here
    // rather than matched as a run of plain text - a line with a pet would otherwise not be seen
    // at all, and every "lists every service line" assertion would quietly count one fewer.
  ].map((match) => `${match[1]!.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim()} | ${match[2]}`);
}

/**
 * Two service lines off `invoice_items`, which is all that table holds that a reader wants.
 *
 * `description` is `service_name_snapshot` and the amount is `amount_minor`.
 *
 * `petName` IS THE SHAPE THE ENDPOINT NOW SENDS, and this fixture carries BOTH of its cases,
 * deliberately: a non-empty string when the line's OWN `source_appointment_service_id` resolves to
 * an appointment service whose appointment names a pet, and `null` - never `""`, never a
 * placeholder - when the line has no source or the source row is unreachable. A manual line is
 * exactly that second case, and the second line here is one.
 *
 * The pet is still not read from the invoice's appointment, and this fixture cannot be used to
 * pretend otherwise: the two lines disagree about it, so a renderer that fell back to a
 * visit-level pet would stamp `Barfi` onto `Nail Trim` and be caught.
 */
function purchaseItems(): Record<string, unknown>[] {
  return [
    { id: "1e000001-0000-4000-8000-00000000000a", description: "Full Groom - Standard",
      quantity: 1, unitPriceMinor: 7500, amountMinor: 7500, linePosition: 1, petName: "Barfi" },
    { id: "1e000002-0000-4000-8000-00000000000b", description: "Nail Trim",
      quantity: 1, unitPriceMinor: 1000, amountMinor: 1000, linePosition: 2, petName: null }
  ];
}

/**
 * THE SHOP'S OWN COPY OF THE WORK, HUNG ON A RECEIPT PAYLOAD SO ITS ABSENCE MEANS SOMETHING.
 *
 * Asserting that a Receipt does not say "Appointment note" against a fixture that never carried
 * one proves nothing at all: the assertion would pass on a renderer that piped the entire Ticket
 * model through, simply because the fixture was empty. So every operational field the Ticket
 * draws, or that an appointment projection carries, is present here with a SENTINEL value, at
 * every level a careless change might reach for one - the receipt root, the invoice, and the
 * items. A renderer that started reading any of them fails the sweep by name.
 *
 * The values are deliberately unmistakable. A sentinel that could occur naturally on a receipt
 * would make a passing sweep meaningless.
 */
const TICKET_ONLY: Record<string, string> = {
  notes: "TICKET-ONLY-appointment-note-do-not-print",
  internalNote: "TICKET-ONLY-internal-note-do-not-print",
  serviceNotes: "TICKET-ONLY-service-note-do-not-print",
  petNote: "TICKET-ONLY-pet-note-do-not-print",
  clientNote: "TICKET-ONLY-client-note-do-not-print",
  groomerNote: "TICKET-ONLY-groomer-note-do-not-print",
  editHistory: "TICKET-ONLY-edit-history-do-not-print",
  statusHistory: "TICKET-ONLY-status-history-do-not-print"
};

/** Every label the Ticket puts on paper. None of them is a heading this document may grow. */
const TICKET_LABELS = [
  "Appointment note", "Latest Note", "Breed", "Groomer", "Duration",
  "Appointment #", "Status history", "Edit history", "Internal note"
];

/**
 * A receipt that ACTUALLY ITEMISES, and whose payload also carries the operational fields above.
 *
 * `receiptFixture` sends `items: []` - every settlement in this file predates the purchase summary
 * and none of them needed one - so a fixture that itemises is built here rather than by changing
 * what thirty existing assertions are handed.
 *
 * `status` is NOT overridden from `TICKET_ONLY`: the invoice's own settlement status is a
 * financial field this payload legitimately carries and the workspace head reads it. The
 * operational status history, which is the Ticket's, is the sentinel above.
 */
function itemisedFixture(
  payments: Payment[],
  invoice: Record<string, unknown> = {}
): Record<string, unknown> {
  const base = receiptFixture(payments, { ...TICKET_ONLY, ...invoice });
  return {
    ...base,
    ...TICKET_ONLY,
    items: purchaseItems().map((item) => ({ ...item, ...TICKET_ONLY }))
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TASK 1 — the four behaviours, executed.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("1. a paymentless Invoice cannot produce a Receipt", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: delete `if(!receiptHasPayment(receipt))return;` from
   * `printPaymentReceipt`. The old source-literal assertion could not: nothing invoked the
   * function with a paymentless receipt, so the guard's body was never executed by any test.
   */
  it("prints NOTHING when the printer is asked for a receipt on an invoice with no payment", () => {
    const client = loadClient();
    client.printPaymentReceipt(receiptFixture([], { balanceMinor: 9201 }));
    expect(client.printed).toEqual([]);
    expect(client.prints.count).toBe(0);
  });

  it("prints NOTHING when the only record against the invoice was voided", () => {
    // A voided record settled nothing, so it evidences nothing — and the invoice is owing again.
    const client = loadClient();
    client.printPaymentReceipt(receiptFixture([cashPayment({ status: "voided" })], { balanceMinor: 9201 }));
    expect(client.printed).toEqual([]);
  });

  it("prints NOTHING for a voided-only record with NOTHING OWED — the gate is the status, not the count", () => {
    // ISOLATING THE FIRST GATE, which nothing else in this file does.
    //
    // Every other voided fixture here is ALSO owing, so `receiptBalanceOutstanding` refuses it
    // first and `receiptHasPayment`'s `status === "recorded"` filter is never the thing that said
    // no. Weakening that filter to `(receipt?.payments||[]).length > 0` therefore left the whole
    // suite green: the void was being caught by the other guard, by luck of the fixture.
    //
    // Holding the balance gate open leaves exactly one question — does a VOIDED row count as a
    // recorded settlement — and it does not. `public/app.js` documents the two gates as
    // INDEPENDENT, each refusing a case the other lets through; a suite that only ever exercises
    // them together cannot show that, which is what this fixture is for.
    const client = loadClient();
    const voidedOnly = receiptFixture([cashPayment({ status: "voided" })], { balanceMinor: 0 });
    expect(client.receiptHasPayment(voidedOnly)).toBe(false);
    expect(client.receiptSettlementComplete(voidedOnly)).toBe(false);
    client.printPaymentReceipt(voidedOnly);
    expect(client.printed).toEqual([]);
  });

  it("prints NOTHING for the $0.00 invoice, which is created Paid with no payment rows at all", () => {
    // `routes.ts` raises a zero-total invoice with status `paid` and `balance_minor = 0` and never
    // writes a payment. Its balance alone would pass a balance-only gate; there is no settlement
    // to evidence, so `receiptHasPayment` is what refuses it.
    const client = loadClient();
    const zero = receiptFixture([], {
      subtotalMinor: 0, taxMinor: 0, totalMinor: 0, balanceMinor: 0, status: "paid"
    });
    expect(client.receiptSettlementComplete(zero)).toBe(false);
    client.printPaymentReceipt(zero);
    expect(client.printed).toEqual([]);
  });

  it("prints NOTHING while a settlement is still in progress", () => {
    // The second gate. $40.00 of a $92.01 invoice is a recorded component of a settlement that has
    // not completed, and evidence of a completed settlement is not what that is.
    const client = loadClient();
    client.printPaymentReceipt(receiptFixture([cashPayment()], { balanceMinor: 5201 }));
    expect(client.printed).toEqual([]);
  });

  it("DOES print once the settlement completed — the positive control for all of the above", () => {
    const client = loadClient();
    client.printPaymentReceipt(receiptFixture([creditPayment(), keyedCardPayment()]));
    expect(client.printed).toHaveLength(1);
    expect(client.printed[0]!.className).toBe("print-root print-payment-receipt");
    expect(client.printed[0]!.innerHTML).toContain("<h1>Receipt #1042</h1>");
    expect(client.prints.count).toBe(1);
  });
});

describe("2. a settled Invoice still exposes Print Invoice", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: restore the mutually-exclusive footer, i.e. replace the two
   * independent conditions with `receipt ? (receiptSettlementComplete(receipt) ? Print Receipt :
   * Print Invoice) : ""`. That is the defect this ladder exists for — one payment against a
   * $92.01 invoice used to remove the operator's only way to print the bill.
   */
  it("offers Print Invoice in EVERY settlement state, unpaid through settled", () => {
    const client = loadClient();
    const states: [string, unknown][] = [
      ["invoice raised, nothing paid", receiptFixture([], { balanceMinor: 9201 })],
      ["one component recorded, still owing", receiptFixture([cashPayment()], { balanceMinor: 5201 })],
      ["settled by one component", receiptFixture([cashPayment({ amountMinor: 9201 })])],
      ["settled by two components", receiptFixture([creditPayment(), keyedCardPayment()])],
      ["settled, then partly refunded", {
        ...receiptFixture([terminalPayment({ amountMinor: 9201 })]), refundedMinor: 1000
      }]
    ];
    for (const [label, receipt] of states) {
      const markup = client.checkoutSurfaceMarkup(checkoutFixture(receipt));
      expect(testids(markup), label).toContain("checkout-print-invoice");
    }
  });

  it("prints the bill, still headed Invoice, when the control is actually pressed", () => {
    const client = loadClient();
    const settled = receiptFixture([creditPayment(), keyedCardPayment()]);
    bindSurface(client, checkoutFixture(settled))["checkout-print-invoice"]!();
    expect(client.printed).toHaveLength(1);
    expect(client.printed[0]!.innerHTML).toContain("<h1>Invoice #1042</h1>");
    // The statement, not the evidence: the bill's own figures and its payment history.
    expect(client.printed[0]!.innerHTML).toContain('data-testid="receipt"');
    // The statement's one emphasised final figure, by the name it now carries.
    expect(client.printed[0]!.innerHTML).toContain("<span>Invoice total</span>");
    expect(client.printed[0]!.innerHTML).not.toContain('data-testid="payment-receipt"');
  });

  it("has no invoice to print before there is an invoice", () => {
    const client = loadClient();
    const markup = client.checkoutSurfaceMarkup(checkoutFixture(null));
    expect(testids(markup)).not.toContain("checkout-print-invoice");
    expect(testids(markup)).not.toContain("checkout-print-receipt");
  });
});

describe("3. Print Receipt is a separate, independent control", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: the same mutually-exclusive footer as above, read from the other
   * side. Independence is asserted as the property it is — each control appears without the other
   * in some state, and both appear together in another — so no single condition can satisfy it.
   */
  it("appears BESIDE Print Invoice on a completed settlement, never instead of it", () => {
    const client = loadClient();
    const ids = testids(
      client.checkoutSurfaceMarkup(checkoutFixture(receiptFixture([creditPayment(), keyedCardPayment()])))
    );
    expect(ids).toContain("checkout-print-invoice");
    expect(ids).toContain("checkout-print-receipt");
    // In that order, and both inside the footer's own action row.
    expect(ids.indexOf("checkout-print-invoice")).toBeLessThan(ids.indexOf("checkout-print-receipt"));
  });

  it("is ABSENT while the invoice is owing, where Print Invoice is present — the two are not one", () => {
    const client = loadClient();
    for (const [label, receipt] of [
      ["nothing paid", receiptFixture([], { balanceMinor: 9201 })],
      ["settlement in progress", receiptFixture([cashPayment()], { balanceMinor: 5201 })],
      ["only record voided", receiptFixture([cashPayment({ status: "voided" })], { balanceMinor: 9201 })]
    ] as [string, unknown][]) {
      const ids = testids(client.checkoutSurfaceMarkup(checkoutFixture(receipt)));
      expect(ids, label).toContain("checkout-print-invoice");
      expect(ids, label).not.toContain("checkout-print-receipt");
    }
  });

  it("walks the settlement ladder, and a REFUND does not take the Receipt back off it", () => {
    // The ladder describe 2 walks for Print Invoice, asked the other question. Print Invoice is on
    // every rung; Print Receipt joins at the rung where the settlement COMPLETED, and — the rung
    // nothing asserted until now — STAYS THERE ONCE MONEY HAS GONE BACK. A refund does not move
    // `balance_minor` (`routes.ts` states that invariant where it computes collected revenue), so
    // a refunded invoice is still settled and its Receipt still evidences what was taken and what
    // was returned. Withdrawing it would deny a client the evidence of a settlement that DID
    // happen. A VOID is the correction that does move the balance back, and it correctly takes
    // the Receipt with it — the owing rungs below are that side of the same gate.
    const client = loadClient();
    const settledOnce = receiptFixture([terminalPayment({ amountMinor: 9201 })]);
    const states: [string, unknown, boolean][] = [
      ["invoice raised, nothing paid", receiptFixture([], { balanceMinor: 9201 }), false],
      ["one component recorded, still owing", receiptFixture([cashPayment()], { balanceMinor: 5201 }), false],
      ["settled by one component", receiptFixture([cashPayment({ amountMinor: 9201 })]), true],
      ["settled by two components", receiptFixture([creditPayment(), keyedCardPayment()]), true],
      ["settled, then partly refunded", { ...settledOnce, refundedMinor: 1000 }, true],
      ["settled, then refunded in full", { ...settledOnce, refundedMinor: 9201 }, true]
    ];
    for (const [label, receipt, evidences] of states) {
      const ids = testids(client.checkoutSurfaceMarkup(checkoutFixture(receipt)));
      // The bill is on every rung, as describe 2 holds. Asserted again here so that a fixture
      // which stopped rendering a footer at all could not pass the Receipt assertion by absence.
      expect(ids, label).toContain("checkout-print-invoice");
      if (evidences) expect(ids, label).toContain("checkout-print-receipt");
      else expect(ids, label).not.toContain("checkout-print-receipt");
    }
  });

  it("prints that settlement when the refunded surface's own control is pressed", () => {
    // Presence at the button and production at the printer are two guarantees, the same way
    // absence and refusal are. The refunded invoice's control is not merely drawn: it puts the
    // Receipt on paper with both movements of money on it.
    const client = loadClient();
    const refunded = { ...receiptFixture([terminalPayment({ amountMinor: 9201 })]), refundedMinor: 1000 };
    bindSurface(client, checkoutFixture(refunded))["checkout-print-receipt"]!();
    expect(client.printed).toHaveLength(1);
    expect(client.printed[0]!.innerHTML).toContain("<h1>Receipt #1042</h1>");
    expect(lineValue(client.printed[0]!.innerHTML, "payment-receipt-total-settled"))
      .toBe("Total settled | $92.01");
    expect(lineValue(client.printed[0]!.innerHTML, "payment-receipt-refunded"))
      .toBe("Refunded | -$10.00");
  });

  it("is ABSENT on the $0.00 visit's Check Out footer, which is Paid with no payment rows at all", () => {
    // `routes.ts` raises a zero-total invoice with status `paid` and `balance_minor = 0` and never
    // writes a payment row. The footer reads `settled` straight off that balance and offers Done,
    // so the balance gate is WIDE OPEN here and `receiptHasPayment` is the only thing refusing a
    // Receipt for a settlement that did not occur. The printer's refusal is asserted in describe
    // 1; this is the footer, where the operator would otherwise be offered the document at all.
    const client = loadClient();
    const zero = receiptFixture([], {
      subtotalMinor: 0, taxMinor: 0, totalMinor: 0, balanceMinor: 0, status: "paid"
    });
    const co = checkoutFixture(zero);
    // The surface really is in its settled mode — otherwise the absence below proves nothing.
    expect(client.checkoutMode(co)).toBe("settled");
    const ids = testids(client.checkoutSurfaceMarkup(co));
    expect(ids).toContain("checkout-done");
    expect(ids).toContain("checkout-print-invoice");
    expect(ids).not.toContain("checkout-print-receipt");
    // Absent, not disabled: there is no handler to reach either.
    expect(Object.keys(bindSurface(client, co))).toEqual(["checkout-print-invoice"]);
  });

  it("cannot be pressed when it was not rendered", () => {
    // Absence at the button and refusal at the printer are two different guarantees and this is
    // the first: no handler exists to reach, because no control was drawn to carry one.
    const client = loadClient();
    const handlers = bindSurface(client, checkoutFixture(receiptFixture([cashPayment()], { balanceMinor: 5201 })));
    expect(Object.keys(handlers)).toEqual(["checkout-print-invoice"]);
  });

  it("keeps the two documents on two conditions, so neither can withdraw the other", () => {
    // Pressed in turn from ONE settled surface: two presses, two documents, two different titles.
    const client = loadClient();
    const handlers = bindSurface(client, checkoutFixture(receiptFixture([creditPayment(), keyedCardPayment()])));
    handlers["checkout-print-invoice"]!();
    handlers["checkout-print-receipt"]!();
    expect(client.printed.map((root) => root.innerHTML.slice(0, 22)))
      .toEqual(["<h1>Invoice #1042</h1>", "<h1>Receipt #1042</h1>"]);
  });
});

describe("4. Print Receipt renders the Receipt, never the Ticket", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: change the `checkout-print-receipt` handler in `checkout()`'s
   * bind to call `printTicket(co.appointment)`. The Ticket is the shop's work sheet; handing it to
   * a client asking for proof of payment hands over an operational document, and the reverse would
   * put money on a sheet meant to carry none.
   */
  it("puts the Receipt on paper and nothing that belongs to a Ticket", () => {
    const client = loadClient();
    bindSurface(client, checkoutFixture(receiptFixture([creditPayment(), keyedCardPayment()])))[
      "checkout-print-receipt"
    ]!();
    expect(client.printed).toHaveLength(1);
    const [root] = client.printed;
    expect(root!.className).toBe("print-root print-payment-receipt");
    expect(root!.innerHTML).toContain('data-testid="payment-receipt"');
    expect(root!.innerHTML).toContain("<h1>Receipt #1042</h1>");
    // What `printTicket` would have produced, which nothing financial may ever contain.
    expect(root!.innerHTML).not.toContain(TICKET_SENTINEL);
    expect(root!.innerHTML).not.toContain("Ticket");
    expect(root!.innerHTML).not.toContain("ticket");
    expect(testids(root!.innerHTML).filter((id) => id.includes("ticket"))).toEqual([]);
  });

  it("proves the sentinel is reachable, so its absence above means something", () => {
    // A test that asserts "the ticket markup is not here" is worthless if the ticket markup could
    // never have been here. This is the positive control for the mutation.
    const client = loadClient();
    client.printTicket({ id: "3f9a0c11" }, null);
    expect(client.printed).toHaveLength(1);
    expect(client.printed[0]!.className).toBe("print-root print-ticket");
    expect(client.printed[0]!.innerHTML).toContain(TICKET_SENTINEL);
  });

  it("does not retitle the Invoice on its way to the Receipt", () => {
    // The old defect in one line: `${receiptHasPayment(receipt)?"Receipt":"Invoice"} #…`. Two
    // documents, two titles, and neither asks what has been paid in order to name itself.
    const client = loadClient();
    const settlements = [
      [],
      [cashPayment()],
      [creditPayment(), keyedCardPayment()],
      [cashPayment({ status: "voided" })]
    ];
    for (const payments of settlements) {
      expect(client.invoiceDocumentTitle(receiptFixture(payments)), JSON.stringify(payments))
        .toBe("Invoice #1042");
    }
    expect(client.paymentReceiptTitle(receiptFixture([cashPayment()]))).toBe("Receipt #1042");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TASK 2 — the Receipt is the settlement's tender composition.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("split tender is ONE Receipt with several tender components", () => {
  const split = () => receiptFixture([creditPayment(), keyedCardPayment()]);

  it("presents the composition the owner asked for: methods, then Total settled", () => {
    const markup = loadClient().paymentReceiptMarkup(split());
    expect(markup).toContain("<h4>Payment methods</h4>");
    expect(tenderLines(markup)).toEqual(["Client credit | $40.00", "Card | $52.01"]);
    expect(lineValue(markup, "payment-receipt-total-settled")).toBe("Total settled | $92.01");
  });

  it("is ONE document with TWO components, not two receipts and not one fused payment", () => {
    const markup = loadClient().paymentReceiptMarkup(split());
    expect(markup.match(/data-testid="payment-receipt"/gu)).toHaveLength(1);
    expect(testids(markup).filter((id) => id === "payment-receipt-payment")).toHaveLength(2);
    // Every amount corresponds to a row in `payments`; none of them is a sum pretending to be one.
    expect(markup).toContain("#c1ed17aa");
    expect(markup).toContain("#ca2d0007");
  });

  it("SAYS 'Payment 1 of N' NOWHERE — a settlement is not a series of checkout events", () => {
    const markup = loadClient().paymentReceiptMarkup(split());
    expect(/Payment\s+\d+\s+of\s+\d+/u.test(markup)).toBe(false);
    expect(markup).not.toContain("<h4>Payment</h4>");
    // And the wording is gone from the client entirely, not merely unreached by this fixture.
    expect(source).not.toContain("Payment ${index+1} of ${settled.length}");
    expect(/Payment \$\{[^}]*\} of \$\{/u.test(source)).toBe(false);
  });

  it("identifies each component separately: reference, and when it was received", () => {
    const markup = loadClient().paymentReceiptMarkup(split());
    expect(markup).toContain(
      `<div data-testid="payment-receipt-received"><span>Received</span><strong>${PREFERRED_STAMP} 2026-09-02T19:30:00.000Z</strong></div>`
    );
    expect(markup).toContain(
      `<div data-testid="payment-receipt-received"><span>Received</span><strong>${PREFERRED_STAMP} 2026-09-02T19:31:00.000Z</strong></div>`
    );
    expect(testids(markup).filter((id) => id === "payment-receipt-reference")).toHaveLength(2);
  });

  it("leaves a voided component off the composition and out of the total", () => {
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([creditPayment({ status: "voided" }), keyedCardPayment()], { balanceMinor: 0 })
    );
    expect(tenderLines(markup)).toEqual(["Card | $52.01"]);
    expect(lineValue(markup, "payment-receipt-total-settled")).toBe("Total settled | $52.01");
    expect(markup).not.toContain("#c1ed17aa");
    expect(markup).not.toContain("voided");
  });
});

describe("client credit is settled, not collected", () => {
  it("counts toward Total settled and toward no claim that money was taken", () => {
    // THE POINT. An aggregate spanning credit and card that called itself "paid" would claim the
    // salon collected $92.01 when it collected $52.01. "Total settled" is true of both components.
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([creditPayment(), keyedCardPayment()])
    );
    expect(lineValue(markup, "payment-receipt-total-settled")).toBe("Total settled | $92.01");
    expect(markup).not.toContain("Total paid");
    expect(markup).not.toContain("Total collected");
    expect(markup).not.toContain("Amount paid");
    expect(testids(markup)).not.toContain("payment-receipt-total-paid");
  });

  it("says on the credit component itself that no money changed hands", () => {
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([creditPayment(), keyedCardPayment()])
    );
    expect(markup).toContain(
      '<p class="fine" data-testid="payment-receipt-credit-note">Settled from the client&#39;s account balance. No money was collected.</p>'
    );
    // ONE note, on the ONE component it is true of. On the card it would be a lie.
    expect(testids(markup).filter((id) => id === "payment-receipt-credit-note")).toHaveLength(1);
  });

  it("puts no such note on a settlement that took money", () => {
    const markup = loadClient().paymentReceiptMarkup(receiptFixture([cashPayment({ amountMinor: 9201 })]));
    expect(testids(markup)).not.toContain("payment-receipt-credit-note");
    expect(markup).not.toContain("No money was collected");
  });

  it("settles the whole invoice from credit alone without claiming a collection", () => {
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([creditPayment({ amountMinor: 9201 })])
    );
    expect(tenderLines(markup)).toEqual(["Client credit | $92.01"]);
    expect(lineValue(markup, "payment-receipt-total-settled")).toBe("Total settled | $92.01");
  });
});

describe("processor identity is stated only where it exists", () => {
  it("names the provider and its payment id", () => {
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([terminalPayment({ amountMinor: 9201 })])
    );
    expect(lineValue(markup, "payment-receipt-provider")).toBe("Processor | Square");
    expect(lineValue(markup, "payment-receipt-provider-payment-id"))
      .toBe("Processor payment ID | sqpmt_9Rt4KvA1");
    // The fixture also carries `externalReference`, and it is NOT a third line: the block headed
    // "the Receipt never prints the operator's processor reference" holds that on its own.

    // Named the way the Invoice's payment history names it, through the shared label.
    expect(tenderLines(markup)).toEqual(["card terminal | $92.01"]);
  });

  it("INVENTS NO PROCESSOR on cash, on credit or on a manually keyed card", () => {
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([creditPayment(), keyedCardPayment()])
    );
    for (const field of [
      "payment-receipt-provider",
      "payment-receipt-provider-payment-id"
    ]) {
      expect(lineValue(markup, field), field).toBeNull();
    }
    // Not an empty row and not a placeholder dash: a label with nothing after it still tells the
    // reader a processor was in this transaction.
    expect(markup).not.toContain("Processor");
    expect(markup).not.toContain("<strong></strong>");
  });

  it("treats a blank processor field as the same absence as null", () => {
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([
        keyedCardPayment({ amountMinor: 9201, provider: "", providerPaymentId: "   ", externalReference: "" })
      ])
    );
    expect(markup).not.toContain("Processor");
    expect(testids(markup)).toEqual([
      "payment-receipt",
      "payment-receipt-salon",
      "payment-receipt-client",
      "payment-receipt-payment",
      "payment-receipt-tender",
      "payment-receipt-reference",
      "payment-receipt-received",
      "payment-receipt-total-settled"
    ]);
  });

  it("falls back to what the ledger stored rather than guessing a provider's name", () => {
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([terminalPayment({ amountMinor: 9201, provider: "stripe" })])
    );
    expect(lineValue(markup, "payment-receipt-provider")).toBe("Processor | stripe");
  });

  it("escapes what came back from the processor", () => {
    // Asserted on the processor payment id, which this document still draws. It used to be
    // asserted on `externalReference`, which it no longer draws at all.
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([
        terminalPayment({ amountMinor: 9201, providerPaymentId: "wag & <b>wash</b>" })
      ])
    );
    expect(markup).toContain("wag &amp; &lt;b&gt;wash&lt;/b&gt;");
    expect(markup).not.toContain("<b>wash</b>");
  });
});

/**
 * THE OPERATOR'S FREE TEXT DOES NOT GO ON THE CLIENT'S PAPER.
 *
 * `external_reference` is whatever an operator typed at checkout: the write schema constrains it
 * to 200 characters and to nothing else, so it can hold a card number, a client's phone number, a
 * remark about the client, or anything else somebody put in a box. The Receipt is the one document
 * of the four HANDED TO A CLIENT, printed on paper the salon stops controlling the moment it
 * crosses the counter.
 *
 * The same endpoint already strips `providerRefundId` from refunds on exactly this reasoning -
 * "a screen has no use for it, and a value a client holds is a value a client can send back" -
 * while this field was still being printed beside it. It is not printed now.
 *
 * NOT A SOURCE GREP. The mutation is to restore the `paymentReceiptLine("Processor reference", …)`
 * call in `paymentReceiptMarkup`; these assertions then fail on the rendered document.
 *
 * THE SERVER PROJECTION IS UNCHANGED and is not what this asserts. `externalReference` may keep
 * reaching this client - every fixture below hands it over - because what is at stake is what the
 * RECEIPT DRAWS.
 */
describe("the Receipt never prints the operator's processor reference", () => {
  /**
   * What an operator can type into an unconstrained 200-character box. The rule under test is that
   * the field's contents are not the salon's to predict, so the document must not draw the field at
   * all - which means the fixture's job is to be arbitrary operator-controlled text, not to be any
   * particular kind of secret.
   *
   * It is a synthetic sentinel rather than a card-shaped literal on purpose. A PAN/CVV-shaped
   * string committed to the repository would trip secret and PCI scanners for the rest of the
   * file's life, and it would prove nothing this does not: the renderer cannot tell one string
   * from another, so a value that must not appear proves the line is not drawn whatever it holds.
   */
  const SENTINEL_DIGITS = "8675309";
  const OPERATOR_FREE_TEXT = `SENTINEL-DO-NOT-PRINT-${SENTINEL_DIGITS}-typed-by-an-operator`;

  it("keeps operator free text typed into `externalReference` off the printed document", () => {
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([
        terminalPayment({ amountMinor: 9201, externalReference: OPERATOR_FREE_TEXT })
      ])
    );
    // NOWHERE. Not as text, not inside an attribute, not as a data value.
    expect(markup).not.toContain(OPERATOR_FREE_TEXT);
    expect(markup).not.toContain(SENTINEL_DIGITS);
    // Nor entity-encoded, nor split by markup the escaper put between the digits: strip the whole
    // document down to its digits and the sentinel run is still not in there.
    expect(markup.replace(/\D/gu, "")).not.toContain(SENTINEL_DIGITS);
    expect(markup).not.toContain("Processor reference");
    expect(testids(markup)).not.toContain("payment-receipt-external-reference");
  });

  it("draws no reference line for ANY payment shape that carries one", () => {
    for (const payment of [
      terminalPayment({ amountMinor: 9201, externalReference: OPERATOR_FREE_TEXT }),
      keyedCardPayment({ amountMinor: 9201, externalReference: OPERATOR_FREE_TEXT }),
      cashPayment({ amountMinor: 9201, externalReference: OPERATOR_FREE_TEXT }),
      creditPayment({ amountMinor: 9201, externalReference: OPERATOR_FREE_TEXT })
    ]) {
      const markup = loadClient().paymentReceiptMarkup(receiptFixture([payment]));
      expect(testids(markup), String(payment.method))
        .not.toContain("payment-receipt-external-reference");
      expect(markup, String(payment.method)).not.toContain(SENTINEL_DIGITS);
    }
  });

  it("STILL NAMES THE PROCESSOR AND ITS PAYMENT ID, which the ruling kept", () => {
    // The reference line went; processor identity did not. A Receipt that named neither would
    // satisfy the two tests above while being a different regression entirely.
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([
        terminalPayment({ amountMinor: 9201, externalReference: OPERATOR_FREE_TEXT })
      ])
    );
    expect(lineValue(markup, "payment-receipt-provider")).toBe("Processor | Square");
    expect(lineValue(markup, "payment-receipt-provider-payment-id"))
      .toBe("Processor payment ID | sqpmt_9Rt4KvA1");
  });

  it("never draws `providerRefundId`, which the server strips before this client sees it", () => {
    // The same rule from the other side: the refund block does not reintroduce the identifier the
    // endpoint deliberately withholds, even were a projection ever to hand it over.
    const markup = loadClient().paymentReceiptMarkup({
      ...receiptFixture([keyedCardPayment({ amountMinor: 9201 })]),
      refunds: [{
        id: "re000001-0000-4000-8000-000000000005",
        paymentId: "ca2d0007-0000-4000-8000-000000000004",
        amountMinor: 1000,
        status: "completed",
        settled: true,
        inFlight: false,
        failed: false,
        label: "Refund",
        providerRefundId: "sqrfd-LEAKED-0007"
      }],
      refundedMinor: 1000
    });
    expect(markup).not.toContain("sqrfd-LEAKED-0007");
  });
});

describe("a refund keeps the tender it came out of", () => {
  /** A split settlement with $10.00 refunded down the CARD, which is where the money went back. */
  const refunded = (overrides: Record<string, unknown> = {}) => ({
    ...receiptFixture([creditPayment(), keyedCardPayment()]),
    refunds: [{
      id: "re000001-0000-4000-8000-000000000005",
      paymentId: "ca2d0007-0000-4000-8000-000000000004",
      amountMinor: 1000,
      status: "completed",
      settled: true,
      inFlight: false,
      failed: false,
      label: "Refund",
      ...overrides
    }],
    // The server sums COMPLETED refunds only: money that is pending or that failed has not moved,
    // so it counts toward nothing. The aggregate follows the rows rather than leading them.
    refundedMinor: overrides.status === undefined || overrides.status === "completed" ? 1000 : 0
  });

  it("draws the refund inside the component it reversed, not in an aggregate that loses it", () => {
    const markup = loadClient().paymentReceiptMarkup(refunded());
    const sections = markup.split('data-testid="payment-receipt-payment"');
    // Section 1 is the credit component, section 2 the card. The refund is in the card's.
    expect(sections[1]).not.toContain("payment-receipt-refund");
    expect(sections[2]).toContain("payment-receipt-refund");
    expect(sections[2]).toContain("<strong>-$10.00</strong>");
  });

  it("states the aggregate as well, without letting it replace the attribution", () => {
    const markup = loadClient().paymentReceiptMarkup(refunded());
    expect(lineValue(markup, "payment-receipt-refunded")).toBe("Refunded | -$10.00");
    // Total settled is what was SETTLED. The refund is a second movement, stated as one rather
    // than netted away — the same shape the Invoice's statement uses.
    expect(lineValue(markup, "payment-receipt-total-settled")).toBe("Total settled | $92.01");
  });

  it("says nothing about refunds when none has been asked for", () => {
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([creditPayment(), keyedCardPayment()])
    );
    expect(testids(markup)).not.toContain("payment-receipt-refund");
    expect(lineValue(markup, "payment-receipt-refunded")).toBeNull();
  });

  it("brackets a refund that is only in flight, so it is never read as money returned", () => {
    const markup = loadClient().paymentReceiptMarkup(
      refunded({ status: "pending", settled: false, inFlight: true })
    );
    expect(markup).toContain("<span>Refunded (pending)</span><strong>($10.00)</strong>");
    expect(markup).not.toContain("<strong>-$10.00</strong>");
  });

  it("leaves a FAILED refund off the evidence — it is a correction that did not happen", () => {
    const markup = loadClient().paymentReceiptMarkup(
      refunded({ status: "failed", settled: false, failed: true })
    );
    expect(testids(markup)).not.toContain("payment-receipt-refund");
  });
});

/**
 * EVERY MONEY FIGURE ON THE RECEIPT IS WRITTEN BY THE WORKSPACE'S OWN FORMATTER.
 *
 * `money()` is what pins a currency's minor units. For the fifteen CLDR zero-decimal codes — COP
 * among them — an unpinned `Intl` writes WHOLE UNITS, so a 10160-minor-unit settlement reads
 * "COP 102" on a document a client pays against. `tests/e2e/currency-display.spec.ts` and
 * `tests/domain/web-money-parity.test.mjs` hold `money()` itself to two decimals.
 *
 * That guarantee only reaches a document if the document's renderer actually goes through it, and
 * NOTHING ELSE IN THIS FILE CAN SEE THE DIFFERENCE: the harness's own stub also writes two
 * decimals, so a figure rendered with its own `toFixed(2)` satisfies every assertion above while
 * printing "$1,016.00" for a workspace billing in pesos.
 *
 * So the stub is replaced by a SENTINEL — the technique the date layer already uses with
 * `PREFERRED_STAMP`. Anything formatted through `money()` comes back stamped; anything a renderer
 * formatted itself does not, and the sweep for a surviving "$" is what fails on it.
 *
 * THIS IS THE LAYER THAT HOLDS `Refunded`. A refund is raised through a Square route, so the
 * browser spec cannot put one on a peso receipt; the aggregate and the bracketed in-flight figure
 * are only reachable here.
 */
describe("every money figure on the Receipt is written by money()", () => {
  const STAMP = "«money»";
  const stampedClient = () =>
    loadClient({ money: `(minor) => ${JSON.stringify(STAMP)} + String(Number(minor || 0))` });

  /**
   * The same split settlement the refund tests use: 4000 of credit, 5201 on a card, 1000 back.
   *
   * ITEMISED, so the purchase summary's figures are swept by the same sentinel. Every figure the
   * summary states is one this formatter wrote - a renderer that formatted a price itself would
   * put a dollar sign on a peso receipt exactly as one that formatted a tender amount itself
   * would, and the summary is where this document now has the most figures to get wrong.
   */
  const refundedReceipt = () => ({
    ...itemisedFixture([creditPayment(), keyedCardPayment()]),
    refunds: [{
      id: "re000001-0000-4000-8000-000000000005",
      paymentId: "ca2d0007-0000-4000-8000-000000000004",
      amountMinor: 1000, status: "completed", settled: true, inFlight: false, failed: false,
      label: "Refund"
    }],
    refundedMinor: 1000
  });

  it("stamps Total settled, every tender amount and Refunded", () => {
    const markup = stampedClient().paymentReceiptMarkup(refundedReceipt());
    // The aggregate, in the minor units the formatter was handed rather than any it invented.
    expect(lineValue(markup, "payment-receipt-total-settled")).toBe(`Total settled | ${STAMP}9201`);
    // Each component of the one settlement, stamped on its own line.
    expect(tenderLines(markup)).toEqual([
      `Client credit | ${STAMP}4000`,
      `Card | ${STAMP}5201`
    ]);
    // And the refund aggregate, which is the figure no browser spec can reach.
    expect(lineValue(markup, "payment-receipt-refunded")).toBe(`Refunded | -${STAMP}1000`);
  });

  it("leaves no figure on the document that the formatter did not write", () => {
    // A renderer that formatted a figure itself would put a dollar sign on a peso receipt. Every
    // real figure being stamped instead, a surviving "$" IS that defect.
    expect(stampedClient().paymentReceiptMarkup(refundedReceipt())).not.toContain("$");
  });

  it("stamps the bracketed figure of a refund that is only in flight", () => {
    const base = refundedReceipt();
    const markup = stampedClient().paymentReceiptMarkup({
      ...base,
      refunds: [{ ...base.refunds[0]!, status: "pending", settled: false, inFlight: true }],
      refundedMinor: 0
    });
    expect(markup).toContain(`(${STAMP}1000)`);
    expect(markup).not.toContain("$");
  });
});

describe("the Receipt is not a second host for the Invoice's money statement", () => {
  it("wears its own class and states no figure that belongs to the bill", () => {
    // `.receipt` and `data-testid="receipt"` mean ONE thing in this client — the invoice's money
    // statement — and browser specs sweep its children to prove the statement's hosts agree
    // figure for figure. A Receipt wearing that class would walk into those sweeps.
    const markup = loadClient().paymentReceiptMarkup(receiptFixture([creditPayment(), keyedCardPayment()]));
    expect(markup).not.toContain('class="wide receipt"');
    expect(markup).not.toContain('data-testid="receipt"');
    expect(markup).toContain('<div class="wide payment-receipt" data-testid="payment-receipt">');
    /*
     * THIS SWEEP USED TO FORBID `Subtotal`, `Discount`, `Tax`, `Tip` AND `Total` BY NAME, and it
     * no longer can: the Receipt now states what was purchased, by a ruling recorded in ADR-011,
     * and those five labels are part of what it states. Section 6.1 holds the summary itself.
     *
     * The sweep is re-aimed rather than deleted, because its SUBJECT was never the figures. It
     * was that this document is not a second HOST for `receiptBodyMarkup` - and the things below
     * are what only that renderer produces: the payment history, the operator corrections against
     * it, the compounding discount breakdown, and a balance line while nothing is owed. A Receipt
     * that grew any of them would have been fused with the bill rather than summarised from it.
     */
    for (const invoiceOnly of [
      "Payment records", "No payment recorded", "Void record", "refund-payment",
      "receipt-discount-step", "receipt-discount-total", "receipt-discount-rate",
      "payment-receipt-balance"
    ]) {
      expect(markup, invoiceOnly).not.toContain(invoiceOnly);
    }
  });

  it("heads itself with the salon and the client, through the shared identity renderer", () => {
    const markup = loadClient().paymentReceiptMarkup(receiptFixture([cashPayment({ amountMinor: 9201 })]));
    expect(markup).toContain('<header class="salon-identity" data-testid="payment-receipt-salon">');
    expect(markup).toContain('<p class="salon-identity-name">Riverside Grooming</p>');
    expect(markup).toContain("<span>Phone:</span> 626-555-0101");
    expect(markup).toContain('<p data-testid="payment-receipt-client">Emma Johnson</p>');
    // Who printed it, then who it is about, then the money — the order the Invoice uses too.
    expect(markup.indexOf("salon-identity")).toBeLessThan(markup.indexOf("Emma Johnson"));
    expect(markup.indexOf("Emma Johnson")).toBeLessThan(markup.indexOf("payment-receipt-payment"));
  });

  it("reads the clock through the workspace's preference layer, never the browser's locale", () => {
    expect(loadClient().paymentReceiptMarkup(receiptFixture([cashPayment({ amountMinor: 9201 })])))
      .toContain(PREFERRED_STAMP);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TASK 3 — the Invoice stays an Invoice, and both documents are reachable from history.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("the Invoice remains an Invoice after settlement", () => {
  it("renders and titles the same statement whatever has been settled against it", () => {
    const client = loadClient();
    for (const [label, receipt] of [
      ["nothing paid", receiptFixture([], { balanceMinor: 9201 })],
      ["in progress", receiptFixture([cashPayment()], { balanceMinor: 5201 })],
      ["settled by split tender", receiptFixture([creditPayment(), keyedCardPayment()])]
    ] as [string, unknown][]) {
      client.openInvoiceWorkspace(receipt);
      expect(workspaceTitle(client.modal.body), label).toBe("Invoice #1042");
      // The statement is the SHARED renderer, drawn into the workspace exactly as it is drawn
      // onto paper and into a settled Check Out. The Receipt is a different document and is
      // never on this surface - it is reached by its own control in the footer.
      expect(client.modal.body, label).toContain('data-testid="receipt"');
      expect(client.modal.body, label).not.toContain('data-testid="payment-receipt"');
    }
  });

  it("has no title anywhere that branches on what has been paid", () => {
    // The defect in one line: `${receiptHasPayment(receipt)?"Receipt":"Invoice"} #…`.
    expect(source).not.toContain("financialDocumentTitle");
    expect(source).not.toContain("invoiceStatusHasPayment");
    expect(/\?\s*"Receipt"\s*:\s*"Invoice"/u.test(source)).toBe(false);
    expect(/\?\s*"Invoice"\s*:\s*"Receipt"/u.test(source)).toBe(false);
  });
});

describe("a settled visit reached from transaction history can reprint both documents", () => {
  it("offers Print Invoice on an invoice in any state, and Print Receipt only once settled", () => {
    const client = loadClient();
    const owing = testids(client.invoiceDocumentActionsMarkup(receiptFixture([], { balanceMinor: 9201 })));
    expect(owing).toContain("invoice-print-invoice");
    expect(owing).not.toContain("invoice-print-receipt");

    const inProgress = testids(
      client.invoiceDocumentActionsMarkup(receiptFixture([cashPayment()], { balanceMinor: 5201 }))
    );
    expect(inProgress).toContain("invoice-print-invoice");
    expect(inProgress).not.toContain("invoice-print-receipt");

    const settled = testids(
      client.invoiceDocumentActionsMarkup(receiptFixture([creditPayment(), keyedCardPayment()]))
    );
    expect(settled).toContain("invoice-print-invoice");
    expect(settled).toContain("invoice-print-receipt");
  });

  it("REPRINTS THE RECEIPT from a settlement that happened in some other session", () => {
    // The capability, not the wording: the data to reproduce a Receipt is persisted, so a client
    // asking for proof of payment a week later gets it from the invoice they are looking at.
    const client = loadClient();
    client.openInvoiceWorkspace(receiptFixture([creditPayment(), keyedCardPayment()]));
    expect(Object.keys(client.modalHandlers).sort())
      .toEqual(["invoice-print-invoice", "invoice-print-receipt"]);

    client.modalHandlers["invoice-print-receipt"]!();
    expect(client.printed).toHaveLength(1);
    expect(client.printed[0]!.innerHTML).toContain("<h1>Receipt #1042</h1>");
    expect(client.printed[0]!.innerHTML).toContain("Total settled");
    // The workspace behind it did not change document.
    expect(workspaceTitle(client.modal.body)).toBe("Invoice #1042");
  });

  it("reprints the Invoice from the same workspace, under the same title", () => {
    const client = loadClient();
    client.openInvoiceWorkspace(receiptFixture([creditPayment(), keyedCardPayment()]));
    client.modalHandlers["invoice-print-invoice"]!();
    expect(client.printed[0]!.innerHTML).toContain("<h1>Invoice #1042</h1>");
    expect(client.printed[0]!.innerHTML).toContain('data-testid="receipt"');
  });

  it("binds no Receipt control at all on an invoice that is still owing", () => {
    const client = loadClient();
    client.openInvoiceWorkspace(receiptFixture([cashPayment()], { balanceMinor: 5201 }));
    expect(Object.keys(client.modalHandlers)).toEqual(["invoice-print-invoice"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TASK 4 — an outstanding balance is never presented as a completed checkout.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("the Check Out surface says when a settlement is unfinished", () => {
  it("names the state and the figure once a component has landed and money is still owed", () => {
    const client = loadClient();
    const markup = client.checkoutSettlementProgressMarkup(
      checkoutFixture(receiptFixture([cashPayment()], { balanceMinor: 5201 }))
    );
    expect(markup).toContain('data-testid="checkout-settlement-progress"');
    expect(markup).toContain("Settlement in progress");
    expect(markup).toContain("$40.00 recorded");
    expect(markup).toContain("<strong>$52.01 still to settle</strong>");
    // Announced, because it appears on a redraw rather than under the operator's cursor.
    expect(markup).toContain('role="status"');
  });

  it("sums every recorded component, so split tender reports what is actually left", () => {
    const client = loadClient();
    const markup = client.checkoutSettlementProgressMarkup(
      checkoutFixture(receiptFixture(
        [creditPayment(), keyedCardPayment({ amountMinor: 2000 }), cashPayment({ status: "voided" })],
        { balanceMinor: 3201 }
      ))
    );
    expect(markup).toContain("$60.00 recorded");
    expect(markup).toContain("<strong>$32.01 still to settle</strong>");
  });

  it("says nothing on an invoice nobody has paid against — that is owing, not in progress", () => {
    const client = loadClient();
    expect(client.checkoutSettlementProgressMarkup(
      checkoutFixture(receiptFixture([], { balanceMinor: 9201 }))
    )).toBe("");
    expect(client.checkoutSettlementProgressMarkup(checkoutFixture(null))).toBe("");
  });

  it("says nothing once the settlement completed", () => {
    const client = loadClient();
    expect(client.checkoutSettlementProgressMarkup(
      checkoutFixture(receiptFixture([creditPayment(), keyedCardPayment()]))
    )).toBe("");
  });

  it("offers Done only on a completed settlement, and Take payment while one is unfinished", () => {
    // Never "Take payment" against a zero balance — that is a route to a double charge — and
    // never "Done" while the invoice is owing, which would be the surface calling an unfinished
    // settlement a finished checkout.
    const client = loadClient();
    const inProgress = testids(client.checkoutSurfaceMarkup(
      checkoutFixture(receiptFixture([cashPayment()], { balanceMinor: 5201 }))
    ));
    expect(inProgress).toContain("checkout-submit");
    expect(inProgress).not.toContain("checkout-done");
    expect(inProgress).toContain("checkout-settlement-progress");

    const settled = testids(client.checkoutSurfaceMarkup(
      checkoutFixture(receiptFixture([creditPayment(), keyedCardPayment()]))
    ));
    expect(settled).toContain("checkout-done");
    expect(settled).not.toContain("checkout-submit");
    expect(settled).not.toContain("checkout-settlement-progress");
  });

  it("has withdrawn the wording that framed an unfinished settlement as a finished one", () => {
    // "Part payment recorded" named an outstanding balance as a completed outcome of a smaller
    // kind, and "$X will remain" described it as a leftover rather than as work still to do.
    expect(source.includes("Part payment recorded"), "Part payment recorded").toBe(false);
    expect(source.includes("${money(due-pay)} will remain"), "$X will remain").toBe(false);
    expect(source.includes("still to settle"), "still to settle").toBe(true);
    // The credit line is a different sentence about a different figure — what is left ON ACCOUNT
    // after this component — and it keeps its own wording.
    expect(source).toContain("credit will remain");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TASK 4 — the Receipt states WHAT WAS PURCHASED, and still states nothing operational.
//
// A Receipt is evidence of a completed settlement, and a client holding one may reasonably ask
// what the settlement was FOR. It may now say so. Itemised detail does not make it an operational
// document — and the line between the two is the whole subject of this section:
//
//   MAY be on it   service or item name, price, discounts, tax, tip, the tender components, a
//                  refund attributed to the component it reverses, and Total settled.
//   MUST NOT be    internal notes, workflow or service notes, appointment edit history,
//                  operational status history, or any other internal work record. Those are the
//                  SHOP'S OWN COPY OF THE WORK. They are the Ticket's, and a document handed
//                  across a counter is not where they belong.
//
// Every assertion below runs the real renderer. The absence assertions run it against
// `itemisedFixture`, whose payload CARRIES every operational field by name — so a renderer that
// later reached for one fails here rather than passing on an empty fixture.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("6.1 the Receipt states what was purchased", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: delete `+paymentReceiptPurchaseMarkup(receipt)` from
   * `paymentReceiptMarkup`. The document then evidences a settlement of $92.01 without ever
   * saying what the $92.01 bought, which is the state this section exists to end.
   */
  it("lists every service line, in the order the invoice holds them", () => {
    const markup = loadClient().paymentReceiptMarkup(
      itemisedFixture([cashPayment({ amountMinor: 9201 })])
    );
    expect(itemLines(markup)).toEqual([
      "Full Groom - Standard (for Barfi) | $75.00",
      "Nail Trim | $10.00"
    ]);
    // Named, because a bare pair of amounts under a salon's address is not self-describing.
    expect(markup).toContain("<h4>Purchased</h4>");
  });

  /**
   * MUTATION THAT MUST FAIL THIS: drop the `name?` guard in `receiptItemPetMarkup`. The manual
   * line then reads `Nail Trim (for )`, which is a broken template on a document a client keeps.
   *
   * WHY THE RECEIPT SHOWS THE PET AT ALL. `invoice_items` did not carry one and the endpoint did
   * not join for one, so this document said nothing about pets and said in its own comment that
   * the absence was deliberate. The endpoint resolves `petName` per item now, from one read that
   * feeds both financial documents - so a household with two dogs on one bill no longer gets two
   * identical `Full Groom` lines with nothing to tell them apart. It is a fact about what was
   * purchased, which is exactly what this section is, and it is the client's own data.
   */
  it("names the pet on the line whose own source names one, and nothing on the line that does not", () => {
    const markup = loadClient().paymentReceiptMarkup(
      itemisedFixture([cashPayment({ amountMinor: 9201 })])
    );
    expect(markup).toContain('<small class="receipt-item-pet">(for Barfi)</small>');
    // ONE parenthetical, on one line. No empty one, no dangling "(for )", no dash.
    expect(markup.match(/\(for /gu)).toHaveLength(1);
    expect(markup).not.toContain("(for )");
    // And the pet is never borrowed from the line beside it: `Nail Trim` has no source pet, so it
    // is drawn as a line about no pet rather than as a second line about Barfi.
    expect(itemLines(markup)[1]).toBe("Nail Trim | $10.00");
  });

  it("states the discount, the tax and the tip that made the total", () => {
    const markup = loadClient().paymentReceiptMarkup(
      itemisedFixture([cashPayment({ amountMinor: 9201 })], {
        subtotalMinor: 8500, discountMinor: 500, taxMinor: 701, tipMinor: 500, totalMinor: 9201
      })
    );
    expect(lineValue(markup, "payment-receipt-subtotal")).toBe("Subtotal | $85.00");
    expect(lineValue(markup, "payment-receipt-discount")).toBe("Discount | -$5.00");
    expect(lineValue(markup, "payment-receipt-tax")).toBe("Tax | $7.01");
    expect(lineValue(markup, "payment-receipt-tip")).toBe("Tip | $5.00");
    expect(lineValue(markup, "payment-receipt-invoice-total")).toBe("Total | $92.01");
  });

  it("draws no row for a figure of zero — 'where applicable', the rule this document already uses", () => {
    // A permanent "Tip $0.00" on a document a client keeps reads as a fact about the visit rather
    // than as the absence of one, which is why `paymentReceiptLine` and the Invoice's own
    // `refundedLine` are both withheld at zero. Same rule, same reason.
    const markup = loadClient().paymentReceiptMarkup(
      itemisedFixture([cashPayment({ amountMinor: 8500 })], {
        subtotalMinor: 8500, discountMinor: 0, taxMinor: 0, tipMinor: 0,
        totalMinor: 8500, balanceMinor: 0
      })
    );
    for (const absent of ["payment-receipt-discount", "payment-receipt-tax", "payment-receipt-tip"]) {
      expect(lineValue(markup, absent), absent).toBeNull();
    }
    // And with nothing to move it, no Subtotal either: a subtotal and a total that are the same
    // number is one figure under two names, which invites a reader to look for the difference.
    expect(lineValue(markup, "payment-receipt-subtotal")).toBeNull();
    expect(lineValue(markup, "payment-receipt-invoice-total")).toBe("Total | $85.00");
    // The items themselves are still there. This is a summary that shortened, not one that left.
    expect(itemLines(markup)).toHaveLength(2);
  });

  it("draws no summary at all for a settlement whose invoice itemises nothing", () => {
    // An empty heading over nothing states nothing, and the tender composition below stands on
    // its own exactly as it did before the summary existed.
    const markup = loadClient().paymentReceiptMarkup(
      receiptFixture([cashPayment({ amountMinor: 9201 })])
    );
    expect(markup).not.toContain("<h4>Purchased</h4>");
    expect(itemLines(markup)).toEqual([]);
    expect(lineValue(markup, "payment-receipt-total-settled")).toBe("Total settled | $92.01");
  });

  it("is a SUMMARY, not a second copy of the Invoice's money statement", () => {
    // The Invoice draws every discount step in applied order, with its rate, and a sum beneath
    // them; it also carries the payment history and the operator corrections against it. The
    // Receipt draws ONE aggregate discount line and no history at all. If these ever appear here,
    // the two documents have been fused.
    const markup = loadClient().paymentReceiptMarkup(
      itemisedFixture([keyedCardPayment({ amountMinor: 9201 })], { discountMinor: 500 })
    );
    for (const invoiceOnly of [
      "receipt-discount-step", "receipt-discount-total", "receipt-discount-rate",
      "Payment records", "Void record", "refund-payment", 'class="wide receipt"'
    ]) {
      expect(markup, invoiceOnly).not.toContain(invoiceOnly);
    }
    // Exactly one discount line, carrying `invoice.discountMinor` — the figure those steps sum to.
    expect(testids(markup).filter((id) => id === "payment-receipt-discount")).toHaveLength(1);
  });

  it("escapes an item description, which is a snapshot of operator-entered text", () => {
    const markup = loadClient().paymentReceiptMarkup({
      ...itemisedFixture([cashPayment({ amountMinor: 9201 })]),
      items: [{ description: '<script>alert("x")</script>', amountMinor: 9201 }]
    });
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });
});

describe("6.2 the Receipt still identifies itself as a Receipt", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: change `paymentReceiptTitle` to return `Invoice #...`, or point
   * `printPaymentReceipt` at `invoiceDocumentTitle`. A larger document is a document more easily
   * mistaken for the bill, and the one thing that tells a client which of the two they are holding
   * is the name at the top of it.
   */
  it("puts its own name on the paper, inside the preview over it, and nowhere says Invoice", () => {
    const client = loadClient();
    client.printPaymentReceipt(itemisedFixture([creditPayment(), keyedCardPayment()]));
    const root = client.printed.at(-1);
    expect(root!.className).toContain("print-payment-receipt");
    expect(root!.innerHTML).toContain("<h1>Receipt #1042</h1>");
    // The PREVIEW'S CHROME names no document — the document under it does, in the <h1> it prints
    // under, which is the one place an operator reads a name off a document anywhere else. A
    // chrome label was a second copy of that name a centimetre above it.
    expect(client.previews.at(-1)!.title).toBe("Print preview");
    expect(client.previews.at(-1)!.body).toContain("<h1>Receipt #1042</h1>");
    // Not the bill, and not the work sheet.
    expect(root!.innerHTML).not.toContain("Invoice #");
    expect(root!.innerHTML).not.toContain(TICKET_SENTINEL);
  });

  it("keeps naming itself a Receipt now that it itemises — the summary did not retitle it", () => {
    const client = loadClient();
    const itemised = itemisedFixture([cashPayment({ amountMinor: 9201 })]);
    expect(client.paymentReceiptTitle(itemised)).toBe("Receipt #1042");
    // The itemised document and the bill are still two documents under two names off one payload.
    expect(client.invoiceDocumentTitle(itemised)).toBe("Invoice #1042");
    const markup = client.paymentReceiptMarkup(itemised);
    expect(markup).toContain('data-testid="payment-receipt"');
    expect(markup).not.toContain('data-testid="receipt"');
  });
});

describe("6.3 Ticket-only operational content never reaches the Receipt", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: draw one of the payload's operational fields on the summary —
   * `+escape(receipt.invoice.notes||"")` inside `paymentReceiptPurchaseMarkup` is enough. The
   * fixture CARRIES that field, so the sweep below sees it appear and fails by name.
   *
   * This is the assertion that would have caught someone piping the Ticket's model in here. Every
   * field is present on the payload at three levels — root, invoice and item — and none of them
   * may render.
   */
  it("prints not one of the operational fields its payload is carrying", () => {
    const markup = loadClient().paymentReceiptMarkup(
      itemisedFixture([creditPayment(), keyedCardPayment()])
    );
    for (const [field, sentinel] of Object.entries(TICKET_ONLY)) {
      expect(markup, field).not.toContain(sentinel);
    }
    // Belt and braces: no sentinel of any kind, however it was reached.
    expect(markup).not.toContain("TICKET-ONLY");
  });

  it("grows none of the Ticket's headings", () => {
    const markup = loadClient().paymentReceiptMarkup(
      itemisedFixture([creditPayment(), keyedCardPayment()])
    );
    for (const label of TICKET_LABELS) {
      expect(markup, label).not.toContain(label);
    }
  });

  it("keeps the operational fields off the PAPER as well as off the screen", () => {
    // The renderer is one function with one output, but the assertion is worth making at the
    // printed root too: this is the copy that leaves the building.
    const client = loadClient();
    client.printPaymentReceipt(itemisedFixture([cashPayment({ amountMinor: 9201 })]));
    expect(client.printed.at(-1)!.innerHTML).not.toContain("TICKET-ONLY");
  });

  it("proves the sentinels are reachable, so their absence above means something", () => {
    // The control for the three tests above. If `itemisedFixture` ever stopped carrying the
    // fields, every sweep would pass vacuously — so one assertion reads them off the fixture.
    const fixture = itemisedFixture([cashPayment({ amountMinor: 9201 })]) as {
      notes: string; invoice: Record<string, string>; items: Record<string, string>[];
    };
    expect(fixture.notes).toContain("TICKET-ONLY");
    expect(fixture.invoice.statusHistory).toContain("TICKET-ONLY");
    expect(fixture.items[0]!.editHistory).toContain("TICKET-ONLY");
  });
});

describe("6.4 split tender still renders correctly beneath the summary", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: reduce `settledComponents` to the first recorded row. The
   * settlement then evidences $40.00 of a $92.01 purchase and the two figures on the document
   * contradict each other — which is precisely what a reader would be left to notice.
   */
  const split = () => itemisedFixture([creditPayment(), keyedCardPayment()]);

  it("keeps ONE purchase summary above TWO tender components", () => {
    const markup = loadClient().paymentReceiptMarkup(split());
    expect(itemLines(markup)).toHaveLength(2);
    expect(tenderLines(markup)).toEqual([
      "Client credit | $40.00",
      "Card | $52.01"
    ]);
    // One settlement, so one summary and one aggregate — never a summary per component.
    expect(testids(markup).filter((id) => id === "payment-receipt-purchase")).toHaveLength(1);
    expect(testids(markup).filter((id) => id === "payment-receipt-total-settled")).toHaveLength(1);
  });

  it("reads what was bought, then how it was tendered, then what it came to", () => {
    const markup = loadClient().paymentReceiptMarkup(split());
    const order = testids(markup);
    expect(order.indexOf("payment-receipt-client"))
      .toBeLessThan(order.indexOf("payment-receipt-purchase"));
    expect(order.indexOf("payment-receipt-purchase"))
      .toBeLessThan(order.indexOf("payment-receipt-payment"));
    expect(order.indexOf("payment-receipt-payment"))
      .toBeLessThan(order.indexOf("payment-receipt-total-settled"));
  });

  it("still says Total settled, never Total paid and never a series to count through", () => {
    const markup = loadClient().paymentReceiptMarkup(split());
    expect(lineValue(markup, "payment-receipt-total-settled")).toBe("Total settled | $92.01");
    expect(markup).not.toContain("Total paid");
    expect(markup).not.toMatch(/Payment \d+ of \d+/u);
    // The purchased total and the settled total are two different statements about one visit and
    // both are on the document. Neither replaced the other.
    expect(lineValue(markup, "payment-receipt-invoice-total")).toBe("Total | $92.01");
  });

  it("keeps a refund under the component it reversed, with the summary untouched above it", () => {
    const base = split();
    const markup = loadClient().paymentReceiptMarkup({
      ...base,
      refunds: [{
        id: "re000001-0000-4000-8000-000000000005",
        paymentId: "ca2d0007-0000-4000-8000-000000000004",
        amountMinor: 1000, status: "completed", settled: true, inFlight: false, failed: false,
        label: "Refund"
      }],
      refundedMinor: 1000
    });
    const sections = markup.split('data-testid="payment-receipt-payment"');
    // Three pieces: everything above the first component, then one per component. The refund is
    // in the CARD's piece and not in the credit's.
    expect(sections).toHaveLength(3);
    expect(sections[1]).not.toContain("payment-receipt-refund");
    expect(sections[2]).toContain("payment-receipt-refund");
    // And the purchase summary — which is above both — is unchanged by a refund. What was bought
    // is not what was given back.
    expect(itemLines(markup)).toHaveLength(2);
    expect(lineValue(markup, "payment-receipt-invoice-total")).toBe("Total | $92.01");
    expect(lineValue(markup, "payment-receipt-refunded")).toBe("Refunded | -$10.00");
  });
});

describe("6.5 `externalReference` is still excluded from the larger document", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: add
   * `paymentReceiptLine("Reference",payment.externalReference,"payment-receipt-external")`
   * to the component block.
   *
   * The document grew, which makes this MORE important rather than less: `external_reference` is
   * up to 200 characters of unconstrained free text an operator types, and a card number typed
   * into it would now be printed on a longer sheet the salon does not control. The sentinel is the
   * one this file already uses — a synthetic string with a digit run in it — rather than a
   * card-shaped literal, which is a thing not to write down in a repository at all.
   */
  const SENTINEL_DIGITS = "8675309";
  const OPERATOR_FREE_TEXT = `SENTINEL-DO-NOT-PRINT-${SENTINEL_DIGITS}-typed-by-an-operator`;

  it("keeps operator free text off an itemised Receipt, on every payment shape that carries it", () => {
    for (const payment of [
      terminalPayment({ amountMinor: 9201, externalReference: OPERATOR_FREE_TEXT }),
      keyedCardPayment({ amountMinor: 9201, externalReference: OPERATOR_FREE_TEXT }),
      cashPayment({ amountMinor: 9201, externalReference: OPERATOR_FREE_TEXT }),
      creditPayment({ amountMinor: 9201, externalReference: OPERATOR_FREE_TEXT })
    ]) {
      const markup = loadClient().paymentReceiptMarkup(itemisedFixture([payment]));
      expect(markup, String(payment.method)).not.toContain(OPERATOR_FREE_TEXT);
      // Digits alone, with the markup's own punctuation stripped, so a value broken across an
      // attribute or an entity could not slip through the containment check above.
      expect(markup.replace(/\D/gu, ""), String(payment.method)).not.toContain(SENTINEL_DIGITS);
      // The document really did render — otherwise the two absences mean nothing.
      expect(itemLines(markup), String(payment.method)).toHaveLength(2);
    }
  });

  it("keeps it off the printed copy too, while still naming the processor the ruling kept", () => {
    const client = loadClient();
    client.printPaymentReceipt(itemisedFixture([
      terminalPayment({ amountMinor: 9201, externalReference: OPERATOR_FREE_TEXT })
    ]));
    const printed = client.printed.at(-1)!.innerHTML;
    expect(printed).not.toContain(SENTINEL_DIGITS);
    // `provider` and `provider_payment_id` are the processor's own identifiers and they stay:
    // this test is about the operator's free-text field, not about processor identity.
    expect(lineValue(printed, "payment-receipt-provider")).toBe("Processor | Square");
    expect(lineValue(printed, "payment-receipt-provider-payment-id"))
      .toBe("Processor payment ID | sqpmt_9Rt4KvA1");
  });
});

describe("6.6 `providerRefundId` is still excluded from the larger document", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: add
   * `paymentReceiptLine("Processor refund ID",refund.providerRefundId,"payment-receipt-refund-id")`
   * to `paymentReceiptRefunds`.
   *
   * `GET /api/invoices/:id/receipt` strips this column before the browser sees it, on the same
   * reasoning as `externalReference`: a screen has no use for it, and a value a client holds is a
   * value a client can send back. This asserts the CLIENT would not draw it even if the projection
   * changed under it, which is the only half of that guarantee a browser can hold.
   */
  const LEAKED = "sqrfd-LEAKED-0007";

  const refunded = (extra: Record<string, unknown>) => ({
    ...itemisedFixture([keyedCardPayment({ amountMinor: 9201 })]),
    refunds: [{
      id: "re000001-0000-4000-8000-000000000005",
      paymentId: "ca2d0007-0000-4000-8000-000000000004",
      amountMinor: 1000, status: "completed", settled: true, inFlight: false, failed: false,
      label: "Refund", ...extra
    }],
    refundedMinor: 1000
  });

  it("draws no processor refund identifier under the component it reversed", () => {
    const markup = loadClient().paymentReceiptMarkup(refunded({ providerRefundId: LEAKED }));
    // The refund itself IS on the document — attribution survives — and its identifier is not.
    expect(markup).toContain('data-testid="payment-receipt-refund"');
    expect(lineValue(markup, "payment-receipt-refunded")).toBe("Refunded | -$10.00");
    expect(markup).not.toContain(LEAKED);
    expect(markup).not.toContain("LEAKED");
  });

  it("keeps it off the printed copy of the itemised document", () => {
    const client = loadClient();
    client.printPaymentReceipt(refunded({ providerRefundId: LEAKED }));
    const printed = client.printed.at(-1)!.innerHTML;
    expect(printed).toContain("<h4>Purchased</h4>");
    expect(printed).not.toContain(LEAKED);
  });
});
