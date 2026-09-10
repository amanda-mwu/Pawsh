import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A BILLED APPOINTMENT CAN REACH ITS OWN INVOICE.
 *
 * The defect this file exists for: the moment an appointment was invoiced, `can.checkout` went
 * false, Take Payment left the appointment footer, and NOTHING REPLACED IT. A settled visit whose
 * own header read "Paid" therefore had no route at all to the bill that said so — the only way in
 * was Client → Transaction History, a detour through the client to reach a document that belongs
 * to the appointment. The Ticket, which carries no money whatsoever, stayed one button away the
 * entire time.
 *
 * The rule these tests hold, for a completed visit:
 *
 *   no invoice yet   Take Payment, gated on `checkout.perform`. No Invoice control at all, because
 *                    there is no document to disable.
 *   invoice owing    Take Payment, with the Invoice reachable beside it in the secondary slot.
 *   invoice settled  Invoice, gated on `payments.view` — reading a bill is not taking payment.
 *                    Take Payment is gone from the footer, which is correct: nothing is owed and
 *                    the server refuses a tender against a settled invoice.
 *
 * THE MIDDLE ROW ARRIVED SECOND, and its own defect is documented at the foot of this file: the
 * footer used to ask whether an invoice RECORD existed rather than what state it was in, so a
 * voided payment left the operator on a screen reading `Open · $79.01 due` with no way to take it.
 *
 * ─── WHY THIS FILE EXECUTES RATHER THAN GREPS ────────────────────────────────────────────────
 *
 * Every assertion below CALLS the client's own functions — the real `derive`, the real footer
 * markup, the real click handler, the real `showInvoiceDocument`. A source-literal assertion could
 * not fail for the reason this file exists: it would pass happily while the handler opened the
 * wrong document, and fail merely because somebody reindented the footer.
 *
 * Three behaviours have a stated mutation that makes them fail, each of which has been run against
 * this file and then reverted:
 *
 *   1. uninvoiced shows Take Payment and no Invoice  — `derive`'s `invoice:` forced to `true`
 *   2. invoiced shows Invoice and no Take Payment    — `derive`'s `invoice:` forced to `false`,
 *                                                      which is the defect exactly as it stood
 *   4. a settled Invoice offers BOTH print controls  — Print Invoice made conditional on the
 *                                                      settlement NOT being complete, restoring
 *                                                      the mutually-exclusive footer
 *
 * ─── THE HARNESS ────────────────────────────────────────────────────────────────────────────
 *
 * `public/app.js` is served as a plain module with no bundler and has top-level side effects that
 * need a document, so the regions under test are sliced out by their own declarations and evaluated
 * against stubs — the harness `tests/ui/payment-receipt.test.ts` established and this one reuses,
 * widened to cover the appointment surface's permission derivation and its footer bindings.
 *
 * `querySelector` answers for a test id ONLY when that id is present in the markup it was handed.
 * That is the property most of these tests turn on: a control the footer did not render cannot be
 * bound, and a handler that was never bound cannot open anything.
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
/** Refunds read off the receipt, which the Invoice body renders. */
const REFUNDS = slice("function receiptRefundsFor(", "\nfunction salonIdentityOf(");
/** The salon identity header and the Invoice's body. */
const RENDERERS = slice(
  "function salonIdentityOf(",
  "\n// Scoped to the copy of the receipt that was just rendered"
);
/**
 * The Invoice workspace: its head, its visit facts, its settlement panel, its footer controls
 * and the bindings that make the two print controls print. `showInvoiceDocument` itself is not
 * in here - it is the surface plumbing, and this file is about which door reaches the Invoice
 * and what the Invoice then offers.
 */
const DOCUMENT = slice(
  "const INVOICE_UNAVAILABLE_REASON=",
  "\n/**\n * Opens the Invoice workspace"
);
/** The billing chip, which is what tells the operator there is a bill to open. */
const BILLING = slice(
  "function appointmentBillingChip(item){",
  "\n// Minutes as an operator says them."
);
/**
 * The appointment detail surface, whose footer carries the financial control.
 *
 * The slice opens at `appointmentPermissionRefusal` rather than at the surface itself: the two
 * helpers above it — the disabled-with-reason attributes, and the client rail's refusal — are what
 * the surface draws for a control or a rail this actor's role does not reach, and it calls both.
 */
const SURFACE = slice(
  "function appointmentPermissionRefusal(action,permission){",
  "\n/**\n * The appointment detail surface: level 1 of the stack."
);
/**
 * `derive`, lifted out of `openCalendarAppointment`'s closure by its own declaration. This is the
 * single place the surface decides what the actor may do with this visit, so it is run rather than
 * reimplemented: a test that recomputed the rule would agree with itself forever.
 */
const DERIVE = slice("  const derive=()=>{", "\n  /**\n   * The appointment note redraws");
/**
 * The two financial bindings out of the same closure's `bind`, lifted by their comment anchors.
 * `openCalendarAppointment` is a 350-line async closure over a live dialog and a stack level; the
 * WIRING is what these tests are about, and this is the wiring, verbatim.
 */
const FOOTER_BINDINGS = slice(
  "    // Check Out is level 2 of the stack now, not a modal over this one",
  "\n    // Level 3, pushed the same way"
);
/**
 * `checkoutMode`, which is what decides whether Check Out RAISES a bill or COLLECTS against one.
 *
 * It is in this file because Take Payment on an appointment that already has an invoice is only
 * safe if that screen collects; a footer offering it while Check Out would have posted a second
 * `/checkout` would be a duplicate-invoice defect wearing a readability fix.
 */
const MODE = slice("function checkoutMode(co){", "\n/**\n * What the bill will come to");
/**
 * `reload`, lifted out of `openCalendarAppointment`'s closure by its own declaration.
 *
 * This is the one function that decides WHAT STATE the footer above is redrawn from, and every
 * caller of it is a redraw after a mutation. Running it is the only way to assert that it asks the
 * server rather than a calendar snapshot a concurrent refresh may not have replaced yet.
 */
const RELOAD = slice(
  // Anchored on its first statement as well as its declaration: `bindAppointmentPhotos` above it
  // has a `const reload=async()=>{` of its own, and slicing from that one would drag 67kB of
  // unrelated client into this harness.
  "  const reload=async()=>{\n    if(stale())return;",
  "\n  // The shared #modal now opens ON TOP"
);

/** The Client → Transaction History route into the same dialog, which must not have moved. */
const HISTORY_BINDING = slice(
  "    // The row is an invoice row and the control opens that invoice, in every status.",
  "\n  }catch(error){toast(error.message);}"
);

/** What the Ticket would put on paper. No financial control may ever reach it. */
const TICKET_SENTINEL = "«the shop’s work sheet»";

interface Recorded {
  /** Every path the client read, in order. */
  reads: string[];
  /** Every stack level `checkout()` was asked to push. */
  checkouts: string[];
  /** Every Ticket the surface was asked to open. */
  tickets: string[];
  /** The shared `#modal`, which no longer hosts the Invoice at all. */
  modal: { title: string; body: string; opens: number };
  modalHandlers: Record<string, () => void>;
  /** The Invoice workspace a door opened, and the handlers bound into it. */
  workspace: {
    title: string;
    body: string;
    opens: number;
    options: { onClose?: () => void } | null;
  };
  workspaceHandlers: Record<string, () => void>;
  /** Every customer whose transaction history a closed Invoice reopened. */
  historyReopens: string[];
  /** How many times anything was opened through `#modal`. The Invoice never is any more. */
  throughModal: number;
  /** Every document a print control put on paper, in order. */
  printed: { document: string }[];
  /** Promises `runDetached` swallowed, so a test can wait for the click it fired. */
  detached: Promise<unknown>[];
  /** Anything `runDetached` caught, which is how a refusal that threw would show. */
  toasts: string[];
}

interface ClientModule extends Recorded {
  grant(...permissions: string[]): void;
  derivePermissions(surface: unknown): Record<string, unknown>;
  appointmentSurfaceMarkup(surface: unknown): string;
  bindAppointmentFooter(dialog: unknown, surface: unknown, id: string): void;
  bindHistoryInvoices(rows: unknown[], customerId: string): void;
  showInvoiceDocument(receipt: unknown): void;
  checkoutMode(co: unknown): string;
  reloadSurface(
    surface: unknown,
    id: string,
    sources: {
      server: unknown;
      cache: unknown;
      reads: string[];
      draws: unknown[];
      activityLoads: number;
    }
  ): Promise<void>;
  /** The receipt payload the stubbed `api` will answer any invoice read with. */
  receipts: Record<string, unknown>;
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
    const paymentMethodLabel = (method) =>
      ({cash:"Cash",external_card:"Card",check:"Check",other:"Other",client_credit:"Client credit"})[method]
        || String(method || "").replaceAll("_", " ");
    const formatPrefDateAndTime = (instant) => instant.toISOString();
    const formatPrefDate = (instant) => instant.toISOString().slice(0, 10);
    const taxPayPercent = (basisPoints) => (Number(basisPoints || 0) / 100).toFixed(2);
    // Mirrors INVOICE_STATUS_LABELS and invoiceRefunded, which live above the slices.
    const invoiceStatusLabel = (status) =>
      ({paid:"Paid",open:"Open",partially_paid:"Partially paid",refunded:"Refunded"})[status]
        || String(status || "").replaceAll("_", " ");
    const invoiceRefunded = (status) => status === "refunded" || status === "partially_refunded";
    const petName = (record) => record.petName || "Pet";

    // THE ACTOR. Every gate under test reads this and nothing else, so a test grants exactly the
    // permissions it means to and the client answers for that actor alone.
    const granted = new Set();
    const allowed = (permission) => granted.has(permission);
    const grant = (...permissions) => { permissions.forEach((one) => granted.add(one)); };
    // Moving a visit is a different surface's concern and is never on for a completed one.
    const appointmentMoveAllowed = () => false;
    // The workspace-wide lock, which decides whether the Move affordance is OFFERED at all -
    // separately from whether this actor may use it. Off here; the two halves are pulled apart in
    // tests/ui/appointment-permission-affordances.test.ts.
    const appointmentsLocked = () => false;

    // The blocks of the surface that are not the footer, named rather than rendered. Each has its
    // own spec; interpolating a sentinel keeps a failure here pointing at the footer.
    const appointmentActivityMarkup = () => "<!--activity-->";
    const appointmentLifecycleMarkup = () => "<!--lifecycle-->";
    const appointmentLockNoteMarkup = () => "<!--lock-note-->";
    const appointmentNotesBlockMarkup = () => "<!--notes-->";
    const appointmentPhotosMarkup = () => "<!--photos-->";
    const appointmentReportCardsMarkup = () => "<!--report-cards-->";
    // WHAT THE TICKET WOULD PUT ON PAPER, so "the Receipt is not the Ticket" is asserted against
    // a value only the Ticket can produce.
    const ticketDocumentMarkup = () => ${JSON.stringify(TICKET_SENTINEL)};

    const reads = [];
    const checkouts = [];
    const tickets = [];
    const toasts = [];
    const detached = [];
    const receipts = {};
    // The server, recorded. A read of an invoice the fixtures do not hold is a failure rather than
    // an empty answer: it would mean the handler asked for the wrong document.
    const api = async (path) => {
      reads.push(path);
      const match = /^\\/api\\/invoices\\/([^/]+)\\/receipt$/u.exec(path);
      if(!match) throw new Error("unexpected read: " + path);
      const receipt = receipts[match[1]];
      if(!receipt) throw new Error("no such invoice: " + match[1]);
      return receipt;
    };
    const toast = (message) => { toasts.push(String(message)); };
    // The real shape: a detached task whose rejection becomes a toast. Held so a test can await
    // the click it fired instead of racing it.
    const runDetached = (task) => {
      detached.push(Promise.resolve().then(task).catch((error) => toast(error.message)));
    };
    const pending = new Set();
    async function runOnce(key, operation){
      if(pending.has(key)) return;
      pending.add(key);
      try { return await operation(); }
      finally { pending.delete(key); }
    }
    const checkout = async (id) => { checkouts.push(id); };
    const openTicket = async (item) => { tickets.push(item.id); };
    // The shared #modal, recorded. \`querySelector\` answers for a test id ONLY when that id is in
    // the markup the dialog was handed — a control that was not rendered cannot be bound.
    const modal = {title:"",body:"",opens:0};
    const modalHandlers = {};
    const queryHost = (markup, handlers) => ({
      querySelector(selector){
        const id = /data-testid="([^"]+)"/u.exec(selector)?.[1];
        if(!id || !markup().includes(\`data-testid="\${id}"\`)) return null;
        return {addEventListener(event, handler){ if(event === "click") handlers[id] = handler; }};
      },
      close(){}
    });
    const openModal = (title, body) => { modal.title = title; modal.body = body; modal.opens += 1; };
    const $ = () => queryHost(() => modal.body, modalHandlers);

    // THE INVOICE WORKSPACE, RECORDED. It is a full-screen surface now rather than a #modal, so
    // what a door reaches is a rendered workspace and the controls bound into it. The markup and
    // the bindings are the client's own; only the <dialog> around them is replaced, because a
    // stack level is not what any test in this file is asking about.
    const workspace = {title:'',body:'',opens:0,options:null};
    const workspaceHandlers = {};
    const showInvoiceDocument = (receipt, options) => {
      workspace.body = invoiceWorkspaceMarkup(receipt, null);
      workspace.title =
        /data-testid="invoice-document-title">([^<]*)</u.exec(workspace.body)?.[1] ?? '';
      workspace.opens += 1;
      workspace.options = options ?? null;
      for(const key of Object.keys(workspaceHandlers)) delete workspaceHandlers[key];
      bindInvoiceWorkspace(queryHost(() => workspace.body, workspaceHandlers), receipt);
    };
    // Where a closed Invoice put the operator back. Recorded so "closing returns to the door it
    // was opened from" is a behaviour rather than a comment.
    const historyReopens = [];
    // The Invoice's own corrections are bound by their own function and tested by their own spec.
    const bindReceiptActions = () => {};
    const printInvoiceDocument = (receipt) => { printed.push({document:"invoice", receipt}); };
    const printPaymentReceipt = (receipt) => { printed.push({document:"receipt", receipt}); };
    const printed = [];
    // The 50ms hand-off between two #modal dialogs is a browser concern; a real timer here would
    // outlive the test run, so the replacement runs immediately.
    const setTimeout = (task) => { task(); return 0; };
    // \`throughModal\` verbatim in shape: it opens the dialog and arms the surface's redraw for
    // when it closes. Counted, because opening the bill outside it would leave a refunded invoice
    // sitting behind a header still reading "Paid".
    let throughModalCount = 0;
    const throughModal = (start) => { throughModalCount += 1; start(); };

    // \`derive\`, run against a surface a test built. Nothing is reimplemented here.
    function derivePermissions(surface){
${DERIVE}
      return derive();
    }

    // The footer's two financial bindings, given the dialog and the surface they close over.
    function bindAppointmentFooter(dialog, surface, id){
      const on = (testid, handler) =>
        dialog.querySelector(\`[data-testid="\${testid}"]\`)?.addEventListener("click", handler);
${FOOTER_BINDINGS}
    }

    // \`reload\`, given the six things it closes over. \`api\` and \`calendarAppointmentById\` are
    // the two sources it chooses between, and the choice between them is what is under test; the
    // rest are recorded so that "the surface redrew from this" is an observation rather than an
    // inference.
    function reloadSurface(surface, id, sources){
      const stale = () => false;
      const calendarAppointmentById = () => sources.cache ?? null;
      const api = async (path) => {
        sources.reads.push(path);
        if(!sources.server) throw new Error("appointment unreachable");
        return sources.server;
      };
      const appointmentPresentation = (item) => ({status:item.status});
      const draw = () => { sources.draws.push(surface.item); };
      const loadActivity = async () => { sources.activityLoads += 1; };
${RELOAD}
      return reload();
    }

    // The Client → Transaction History route into the same document. The customer id is what
    // the list belongs to, and what a closed Invoice has to come back to.
    function bindHistoryInvoices(rows, id){
      const $$ = () => rows;
      const showPetDocuments = () => {};
      const showCustomerHistory = (customerId) => { historyReopens.push(customerId); };
${HISTORY_BINDING}
    }
  `;
  const exported = `return {
    grant, derivePermissions, appointmentSurfaceMarkup, bindAppointmentFooter, bindHistoryInvoices,
    checkoutMode, reloadSurface,
    showInvoiceDocument, receipts, reads, checkouts, tickets, toasts, detached, modal,
    modalHandlers, workspace, workspaceHandlers, historyReopens, printed,
    get throughModal(){ return throughModalCount; }
  };`;
  const factory = new Function(
    "escape",
    "escapeAttr",
    [prelude, GATES, MODE, REFUNDS, RENDERERS, DOCUMENT, BILLING, SURFACE, exported].join("\n")
  ) as (escape: unknown, escapeAttr: unknown) => ClientModule;
  return factory(escape, escapeAttr);
}

const INVOICE_ID = "a0990da6-1735-4471-a7af-14808ed44b15";

/** A recorded cash settlement: everything a manual payment has and nothing a processor adds. */
function cashPayment(amountMinor: number) {
  return {
    id: "8f1c2ade-0000-4000-8000-000000000001",
    status: "recorded",
    method: "cash",
    amountMinor,
    recordedAt: "2026-09-02T19:30:00.000Z",
    provider: null,
    providerPaymentId: null,
    externalReference: null,
    providerTipMinor: null
  };
}

/** The `GET /api/invoices/:id/receipt` payload, settled unless a test says otherwise. */
function receiptFixture({ balanceMinor = 0 }: { balanceMinor?: number } = {}) {
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
      balanceMinor,
      // The two non-money invoice columns the workspace head and its visit facts read.
      status: balanceMinor ? "partially_paid" : "paid",
      createdAt: "2026-09-02T18:00:00.000Z",
      appointmentId: "ed2dd1b0-6c58-4a92-9a4f-0b6d9ee7c111"
    },
    items: [],
    discounts: [],
    payments: [cashPayment(9201 - balanceMinor)],
    refunds: [],
    taxLines: []
  };
}

/**
 * The appointment as the read returns it. `invoiceId`, `invoiceStatus` and `invoiceBalanceMinor`
 * come off the one projection in `appointmentReadSql`, so a fixture that carries the status carries
 * the id too — the shapes that would let them disagree do not exist on the wire.
 */
function appointmentSurface(overrides: Record<string, unknown> = {}) {
  const item = {
    id: "ed2dd1b0-6c58-4a92-9a4f-0b6d9ee7c111",
    status: "completed",
    version: 3,
    customerId: "c0000000-0000-4000-8000-000000000001",
    petId: "p0000000-0000-4000-8000-000000000001",
    operationalNotes: null,
    invoiceId: null,
    invoiceStatus: null,
    invoiceBalanceMinor: null,
    ...overrides
  };
  return {
    item,
    model: {
      status: item.status,
      dateLabel: "Wed 2 Sep",
      timeRange: "10:00 – 11:30",
      durationMinutes: 90,
      groomer: "Priya Raman",
      petName: "Biscuit",
      breed: "Cavapoo",
      rabiesNeeded: false,
      warning: null,
      totalPriceMinor: 8500,
      serviceSnapshots: [{ name: "Full groom", durationMinutes: 90, priceMinor: 8500 }]
    },
    activity: { items: [], failed: false },
    photos: { data: null, failed: false },
    cards: { data: null, failed: false },
    client: { loaded: false, failed: false },
    permissions: null as unknown,
    note: { open: false, draft: null, baseVersion: null, conflict: null, error: null, saving: false }
  };
}

/** A settled visit: completed, invoiced, paid in full. The state the defect was found in. */
function settledSurface() {
  return appointmentSurface({
    invoiceId: INVOICE_ID,
    invoiceStatus: "paid",
    invoiceBalanceMinor: 0
  });
}

/**
 * Renders the surface for an actor and binds its real footer handlers to it.
 *
 * The handlers map is what a click reaches. A control the footer did not render is not in it,
 * which is how "there is no route" is asserted as behaviour rather than as an absent string.
 */
function openSurface(client: ClientModule, surface: ReturnType<typeof appointmentSurface>) {
  surface.permissions = client.derivePermissions(surface);
  const markup = client.appointmentSurfaceMarkup(surface);
  const handlers: Record<string, () => void> = {};
  client.bindAppointmentFooter(
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
    surface,
    String(surface.item.id)
  );
  return { markup, handlers };
}

/** The `<button>` carrying one test id, as it was actually rendered. */
function control(markup: string, testid: string): string | null {
  const match = new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`, "u").exec(markup);
  return match?.[0] ?? null;
}

/**
 * Clicks one control, by firing the handler the client actually bound to it.
 *
 * A control that was never rendered was never bound, so this reports THAT rather than failing with
 * a TypeError three lines later — the distinction matters, because "no route to the invoice" is
 * precisely the defect these tests hold.
 */
function fire(handlers: Record<string, (() => void) | undefined>, testid: string): void {
  const handler = handlers[testid];
  if (!handler) throw new Error(`no handler is bound for ${testid}`);
  handler();
}

/** Runs every detached task the last click started, so an async handler is not raced. */
async function settle(client: ClientModule): Promise<void> {
  await Promise.all(client.detached);
}

describe("the financial control on a completed appointment", () => {
  it("offers Take Payment and no Invoice while the visit is unbilled", async () => {
    const client = loadClient();
    client.grant("checkout.perform", "payments.view");
    const surface = appointmentSurface();
    const { markup, handlers } = openSurface(client, surface);

    // The bill does not exist, so there is nothing to disable and nothing is drawn. Absence is the
    // honest answer here, and it is the ONLY case on this footer where absence is.
    expect(control(markup, "appointment-invoice")).toBeNull();
    expect(handlers["appointment-invoice"]).toBeUndefined();
    expect(surface.permissions).toMatchObject({ invoice: false, checkout: true });

    // Billing the visit is still the primary action, and still the one the operator came for.
    expect(control(markup, "appointment-take-payment")).toContain("primary");
    fire(handlers, "appointment-take-payment");
    await settle(client);
    expect(client.checkouts).toEqual([surface.item.id]);
    // Nothing financial was read: there is no document to read yet.
    expect(client.reads).toEqual([]);
  });

  it("replaces Take Payment with Invoice the moment the visit is billed", async () => {
    const client = loadClient();
    client.grant("checkout.perform", "payments.view");
    const surface = settledSurface();
    const { markup, handlers } = openSurface(client, surface);

    // The chip that tells the operator there is a bill, and the control that opens it. Before this
    // fix the first was here and the second was not, which is the whole of the defect.
    expect(markup).toContain('data-testid="appointment-billing">Paid<');
    const invoice = control(markup, "appointment-invoice");
    expect(invoice).not.toBeNull();
    expect(invoice).toContain("primary");
    expect(invoice).not.toContain("disabled");
    expect(handlers["appointment-invoice"]).toBeInstanceOf(Function);

    // Take Payment is gone from the footer entirely, not merely displaced: the server refuses a
    // second checkout on an invoiced visit, so offering it would be offering a refusal.
    expect(control(markup, "appointment-take-payment")).toBeNull();
    expect(handlers["appointment-take-payment"]).toBeUndefined();
    expect(surface.permissions).toMatchObject({ invoice: true, checkout: false });

    // Exactly one primary control in the footer, so the Invoice's claim on that slot is real
    // rather than shared with the Ticket it displaced.
    expect(markup.match(/class="primary compact"/gu)?.length).toBe(1);
    expect(control(markup, "appointment-ticket")).toContain("secondary");
    // The Ticket is still one button away in every state. It carries no money and never did.
    expect(handlers["appointment-ticket"]).toBeUndefined();
    expect(markup).toContain('data-testid="appointment-ticket"');
  });

  it("opens the one Invoice workspace, titled Invoice #N, over the visit that raised it", async () => {
    const client = loadClient();
    client.grant("payments.view");
    client.receipts[INVOICE_ID] = receiptFixture();
    const surface = settledSurface();
    const { handlers } = openSurface(client, surface);

    fire(handlers, "appointment-invoice");
    await settle(client);

    // The existing endpoint, for THIS appointment's invoice, read exactly once.
    expect(client.reads).toEqual([`/api/invoices/${INVOICE_ID}/receipt`]);
    expect(client.toasts).toEqual([]);
    // The one workspace, with its existing title. Settlement moves a balance; it does not turn
    // an Invoice into some other document, and this surface does not get to rename it.
    expect(client.workspace.opens).toBe(1);
    expect(client.workspace.title).toBe("Invoice #1042");
    // AND NOT THROUGH #modal. The Invoice used to be a 650px form dialog opened over the visit;
    // it is a level of the same surface stack now, so the shared form dialog is not touched at
    // all and there is no `close` listener standing in for a stack pop.
    expect(client.throughModal).toBe(0);
    expect(client.modal.opens).toBe(0);
    // The visit is what it comes back to, so the door hands in no reopen of its own: popping
    // the level puts the appointment surface underneath back on screen by itself.
    expect(client.workspace.options).toBeNull();
  });

  it("gives a settled invoice opened from the appointment BOTH print controls", async () => {
    const client = loadClient();
    client.grant("payments.view");
    client.receipts[INVOICE_ID] = receiptFixture();
    const { handlers } = openSurface(client, settledSurface());

    fire(handlers, "appointment-invoice");
    await settle(client);

    // Two documents, two controls, neither excluding the other. An invoice is printable in every
    // settlement state; the receipt evidences the settlement that completed. A paid visit has both
    // and the operator chooses, rather than the client choosing from what has been paid.
    expect(client.workspace.body).toContain('data-testid="invoice-print-invoice"');
    expect(client.workspace.body).toContain('data-testid="invoice-print-receipt"');

    // And each prints its own document. Bound handlers, run — a control that renders and prints
    // the wrong thing would pass a markup assertion.
    fire(client.workspaceHandlers, "invoice-print-invoice");
    fire(client.workspaceHandlers, "invoice-print-receipt");
    expect(client.printed.map((entry: { document: string }) => entry.document))
      .toEqual(["invoice", "receipt"]);
    // Nothing financial can reach the shop's work sheet.
    expect(JSON.stringify(client.printed)).not.toContain(TICKET_SENTINEL);
    expect(client.workspace.body).not.toContain(TICKET_SENTINEL);

    // THE TWO CAPABILITIES PAWSH DOES NOT HAVE, DRAWN AND REFUSING. Send Receipt and Ask for
    // Review exist nowhere in this product — no control, no route, no notification type — so
    // they are disabled with a reason rather than hidden, and neither is bound to anything.
    for (const unavailable of ["invoice-send-receipt", "invoice-ask-review"]) {
      expect(client.workspace.body, unavailable).toContain(`data-testid="${unavailable}"`);
      expect(client.workspaceHandlers[unavailable], unavailable).toBeUndefined();
    }
    expect(client.workspace.body).toContain('data-testid="invoice-unavailable-note"');
  });

  it("refuses to open the invoice without payments.view, in the handler and not in the markup", async () => {
    const client = loadClient();
    // An operator who may work the visit and even take money on it, but may not read what money
    // has been recorded. Nothing here widens any role.
    client.grant("checkout.perform", "appointments.edit");
    client.receipts[INVOICE_ID] = receiptFixture();
    const surface = settledSurface();
    const { markup, handlers } = openSurface(client, surface);

    // The control STAYS ON SCREEN and says why. Drawing nothing would tell this operator there is
    // no invoice, which the billing chip beside it has already contradicted.
    const invoice = control(markup, "appointment-invoice");
    expect(invoice).toContain("disabled");
    expect(invoice).toContain('aria-disabled="true"');
    expect(invoice).toContain('title="You do not have permission to view invoices"');
    expect(surface.permissions).toMatchObject({ invoice: true, invoiceViewable: false });

    // THE HANDLER ITSELF REFUSES. `disabled` is a fact about a DOM node and survives exactly as
    // long as the console leaves it alone; this is a fact about the actor. Firing the bound
    // handler is what a re-enabled button does, and it must read nothing and open nothing.
    expect(handlers["appointment-invoice"]).toBeInstanceOf(Function);
    fire(handlers, "appointment-invoice");
    await settle(client);
    expect(client.reads).toEqual([]);
    expect(client.workspace.opens).toBe(0);
    expect(client.throughModal).toBe(0);
    // It refuses quietly rather than throwing: a control the operator was told is unavailable
    // should not answer a stray click with an error.
    expect(client.toasts).toEqual([]);
  });

  it("draws no control at all when the appointment was never invoiced", () => {
    const client = loadClient();
    client.grant("payments.view");
    // Cancelled: read-only, never billed. Close keeps the primary slot, because there is nothing
    // on this visit to come for.
    const surface = appointmentSurface({ status: "cancelled" });
    const { markup, handlers } = openSurface(client, surface);

    expect(control(markup, "appointment-invoice")).toBeNull();
    expect(handlers["appointment-invoice"]).toBeUndefined();
    expect(control(markup, "appointment-close")).toContain("primary");
    expect(markup.match(/class="primary compact"/gu)?.length).toBe(1);
  });
});

const CUSTOMER_ID = "c0000000-0000-4000-8000-000000000001";

describe("the routes into the Invoice workspace", () => {
  it("leaves Client → Transaction History opening the same document unchanged", async () => {
    const client = loadClient();
    client.grant("payments.view");
    client.receipts[INVOICE_ID] = receiptFixture();
    const clicks: Array<() => Promise<void>> = [];
    const row = {
      dataset: { invoiceId: INVOICE_ID },
      addEventListener(event: string, handler: () => Promise<void>) {
        if (event === "click") clicks.push(handler);
      }
    };

    client.bindHistoryInvoices([row], CUSTOMER_ID);
    expect(clicks).toHaveLength(1);
    await clicks[0]!();

    // Same endpoint, same renderer, same title. The appointment footer is a SECOND door into one
    // document, not a second document.
    expect(client.reads).toEqual([`/api/invoices/${INVOICE_ID}/receipt`]);
    expect(client.workspace.opens).toBe(1);
    expect(client.workspace.title).toBe("Invoice #1042");
    expect(client.workspace.body).toContain('data-testid="invoice-print-invoice"');
    expect(client.workspace.body).toContain('data-testid="invoice-print-receipt"');
  });

  it("puts the operator back in the transaction history they opened it from", async () => {
    // THE DOOR CLOSES BACK ONTO THE ROOM IT OPENED OUT OF. The history list is `#modal` and the
    // Invoice takes the whole viewport, so the list has to be dismissed for the Invoice to stand
    // on its own — which used to leave an operator who closed the Invoice back on the client
    // card rather than on the transactions they were working through.
    const client = loadClient();
    client.grant("payments.view");
    client.receipts[INVOICE_ID] = receiptFixture();
    const clicks: Array<() => Promise<void>> = [];
    const row = {
      dataset: { invoiceId: INVOICE_ID },
      addEventListener(event: string, handler: () => Promise<void>) {
        if (event === "click") clicks.push(handler);
      }
    };

    client.bindHistoryInvoices([row], CUSTOMER_ID);
    await clicks[0]!();
    expect(client.historyReopens).toEqual([]);

    client.workspace.options?.onClose?.();
    await settle(client);
    expect(client.historyReopens).toEqual([CUSTOMER_ID]);
  });

  it("shows an unsettled invoice without a Receipt from either route", async () => {
    // The rule the Invoice dialog already owned, asserted from the new door as well: Print Receipt
    // appears only once a settlement COMPLETED, and is absent rather than disabled until then.
    const client = loadClient();
    client.grant("payments.view");
    client.receipts[INVOICE_ID] = receiptFixture({ balanceMinor: 4000 });
    const { handlers } = openSurface(
      client,
      appointmentSurface({
        invoiceId: INVOICE_ID,
        invoiceStatus: "partially_paid",
        invoiceBalanceMinor: 4000
      })
    );

    fire(handlers, "appointment-invoice");
    await settle(client);

    expect(client.workspace.title).toBe("Invoice #1042");
    expect(client.workspace.body).toContain('data-testid="invoice-print-invoice"');
    expect(client.workspace.body).not.toContain('data-testid="invoice-print-receipt"');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AFTER A VOID, THE VISIT OFFERS A WAY TO TAKE THE MONEY IT SAYS IS OWED.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The second defect on this footer, reported by the owner and reproduced exactly:
 *
 *   void the payment on a settled invoice
 *     -> the invoice goes back to Open with $79.01 owing
 *     -> the appointment chip correctly reads `Open · $79.01 due`
 *     -> the footer still shows Invoice, and there is NO Take Payment
 *
 * The operator was stranded on the one screen that had just told them money was due. The cause was
 * two lines that both asked whether an invoice RECORD existed rather than what state it was in:
 * `checkout: status==="completed" && !invoiced && ...` and `invoice: Boolean(item.invoiceId)`.
 * Voiding a payment does not remove the invoice, so `!invoiced` stayed false forever.
 *
 * THE THREE STATES, and they are decided from `invoiceStatus` and `invoiceBalanceMinor` - the two
 * authoritative financial columns already on the appointment projection, and the same two the
 * billing chip has always been drawn from:
 *
 *   A. no invoice                     Take Payment
 *   B. invoice, balance outstanding   Take Payment, with Invoice still reachable beside it
 *   C. invoice, settled               Invoice
 *
 * Four behaviours have a stated mutation that makes them fail, each run against this file and
 * then reverted:
 *
 *   5. state B offers Take Payment      - restore `!invoiced`, which is the defect exactly
 *   6. state B keeps Invoice reachable  - withhold `invoice` whenever a balance is outstanding
 *   7. a zero balance takes no money    - drop the balance test from `appointmentInvoiceOutstanding`
 *   8. the surface reloads from the server - put `calendarAppointmentById(id) ||` back in front of
 *                                         the read, which is the stale-snapshot race itself
 */

/** A visit whose settled payment has just been voided: Open, whole balance back on the bill. */
function voidedSurface() {
  return appointmentSurface({
    invoiceId: INVOICE_ID,
    invoiceStatus: "open",
    invoiceBalanceMinor: 7901
  });
}

describe("a completed visit with money still owed on its invoice", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: restore `checkout: status==="completed" && !invoiced && ...`.
   */
  it("offers Take Payment as the primary action once a void reopens the invoice", () => {
    const client = loadClient();
    client.grant("checkout.perform", "payments.view");
    const surface = voidedSurface();
    const { markup, handlers } = openSurface(client, surface);

    // The chip already said so. Now the footer agrees with it.
    expect(markup).toContain('data-testid="appointment-billing">Open · $79.01 due<');
    expect(surface.permissions).toMatchObject({ invoice: true, checkout: true });

    const take = control(markup, "appointment-take-payment");
    expect(take).not.toBeNull();
    expect(take).toContain("primary");
    expect(handlers["appointment-take-payment"]).toBeInstanceOf(Function);
  });

  /**
   * MUTATION THAT MUST FAIL THIS: withhold `invoice` whenever a balance is outstanding. The bill
   * demonstrably exists and would again have no route from the visit that raised it - the first
   * defect on this footer, rebuilt from the other side.
   */
  it("keeps the Invoice reachable beside it, in the secondary slot", () => {
    const client = loadClient();
    client.grant("checkout.perform", "payments.view");
    const { markup, handlers } = openSurface(client, voidedSurface());

    const invoice = control(markup, "appointment-invoice");
    expect(invoice).not.toBeNull();
    expect(invoice).toContain("secondary");
    expect(invoice).not.toContain("disabled");
    expect(handlers["appointment-invoice"]).toBeInstanceOf(Function);

    // One primary control, and it is the money. Two buttons cannot both claim the slot.
    expect(markup.match(/class="primary compact"/gu)).toHaveLength(1);
  });

  it("opens Check Out with the id of the visit, which is what the existing invoice hangs off", async () => {
    const client = loadClient();
    client.grant("checkout.perform", "payments.view");
    const surface = voidedSurface();
    const { handlers } = openSurface(client, surface);

    fire(handlers, "appointment-take-payment");
    await settle(client);
    expect(client.checkouts).toEqual([surface.item.id]);
    // And nothing financial was read by the footer itself: Check Out owns that read.
    expect(client.reads).toEqual([]);
  });

  /**
   * WHY OFFERING IT CANNOT RAISE A SECOND INVOICE, asserted against the function that decides.
   *
   * `checkout()` loads the receipt for `appointment.invoiceId` before it draws anything, and
   * `checkoutMode` reads the balance off that receipt. "collect" is the mode that never posts
   * `/api/appointments/:id/checkout` at all - it tenders against `co.receipt.invoice`. That the
   * POST is genuinely never sent is proven in a browser by
   * `tests/e2e/appointment-take-payment-after-void.spec.ts` and by the
   * "@regression-checkout an existing invoice is collected against, not raised again" spec.
   */
  it("puts Check Out in COLLECT mode, the mode that never raises a second invoice", () => {
    const client = loadClient();
    // The state a void leaves behind: the invoice is there, and it has a balance again.
    expect(client.checkoutMode({ receipt: receiptFixture({ balanceMinor: 7901 }) })).toBe("collect");
    // Settled, and the same screen would show the bill rather than offer to take anything.
    expect(client.checkoutMode({ receipt: receiptFixture() })).toBe("settled");
    // No invoice at all is the only state in which it raises one.
    expect(client.checkoutMode({ receipt: null })).toBe("build");
  });

  it("withholds Take Payment from an actor who may read the bill but not settle it", () => {
    const client = loadClient();
    client.grant("payments.view");
    const { markup, handlers } = openSurface(client, voidedSurface());

    // Absent, never disabled: the precedent this footer already keeps for a transition the server
    // would refuse. The bill takes the primary slot instead, because it is the only thing offered.
    expect(control(markup, "appointment-take-payment")).toBeNull();
    expect(handlers["appointment-take-payment"]).toBeUndefined();
    expect(control(markup, "appointment-invoice")).toContain("primary");
  });

  it("offers it on a partially paid invoice too, for the balance that is left", () => {
    const client = loadClient();
    client.grant("checkout.perform", "payments.view");
    const surface = appointmentSurface({
      invoiceId: INVOICE_ID,
      invoiceStatus: "partially_paid",
      invoiceBalanceMinor: 5201
    });
    const { markup } = openSurface(client, surface);
    expect(surface.permissions).toMatchObject({ checkout: true, invoice: true });
    expect(control(markup, "appointment-take-payment")).toContain("primary");
    expect(markup).toContain('data-testid="appointment-billing">Partially paid · $52.01 due<');
  });
});

describe("a completed visit with nothing owed", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: drop the balance test from `appointmentInvoiceOutstanding`, so
   * the status alone decides. A settled bill would then offer a tender the server refuses.
   */
  it("offers the Invoice and no Take Payment once the balance reaches zero again", () => {
    const client = loadClient();
    client.grant("checkout.perform", "payments.view");
    const surface = settledSurface();
    const { markup, handlers } = openSurface(client, surface);

    expect(surface.permissions).toMatchObject({ invoice: true, checkout: false });
    expect(control(markup, "appointment-take-payment")).toBeNull();
    expect(handlers["appointment-take-payment"]).toBeUndefined();
    expect(control(markup, "appointment-invoice")).toContain("primary");
  });

  it("treats a refunded invoice as settled rather than as owing", () => {
    // Money going back never raises the balance - that is deliberate on the server, so a refund
    // does not put the bill in front of whoever chases outstanding ones - and this footer must not
    // reintroduce that by reading the status alone.
    const client = loadClient();
    client.grant("checkout.perform", "payments.view");
    for (const invoiceStatus of ["refunded", "partially_refunded"]) {
      const surface = appointmentSurface({
        invoiceId: INVOICE_ID,
        invoiceStatus,
        invoiceBalanceMinor: 0
      });
      const { markup } = openSurface(client, surface);
      expect(control(markup, "appointment-take-payment"), invoiceStatus).toBeNull();
      expect(control(markup, "appointment-invoice"), invoiceStatus).toContain("primary");
    }
  });

  /**
   * MUTATION THAT MUST FAIL THIS: drop the balance test from `appointmentInvoiceOutstanding`, so
   * the status alone decides.
   *
   * WHY THE RULE READS BOTH COLUMNS. The server cannot produce this row: `applyInvoiceSettlement`
   * writes `balance_minor` and `status` in one statement and `invoiceStatusAfterSettlement` derives
   * the status FROM the balance, so an `open` invoice always has a balance. A CLIENT can hold it —
   * an appointment patched field by field, a projection half-refreshed — and the question this
   * footer is answering is "may the operator press a button that takes money". Offering a tender
   * against a bill whose own balance says $0.00 is the one wrong answer available here, so the
   * figure is read as well as the word and the two have to agree.
   */
  it("takes no money against a bill whose balance says nothing is left, whatever the status says", () => {
    const client = loadClient();
    client.grant("checkout.perform", "payments.view");
    for (const invoiceStatus of ["open", "partially_paid", "draft"]) {
      const surface = appointmentSurface({
        invoiceId: INVOICE_ID,
        invoiceStatus,
        invoiceBalanceMinor: 0
      });
      const { markup } = openSurface(client, surface);
      expect(surface.permissions, invoiceStatus).toMatchObject({ checkout: false });
      expect(control(markup, "appointment-take-payment"), invoiceStatus).toBeNull();
      // The bill is still reachable: it exists, and the operator can still read and print it.
      expect(control(markup, "appointment-invoice"), invoiceStatus).toContain("primary");
    }
  });

  it("still offers Take Payment on a visit that was never invoiced at all", () => {
    // State A, unchanged: the bill does not exist, so there is nothing to disable and nothing is
    // drawn beside the action that raises it.
    const client = loadClient();
    client.grant("checkout.perform", "payments.view");
    const surface = appointmentSurface();
    const { markup } = openSurface(client, surface);
    expect(surface.permissions).toMatchObject({ invoice: false, checkout: true });
    expect(control(markup, "appointment-take-payment")).toContain("primary");
    expect(control(markup, "appointment-invoice")).toBeNull();
  });
});

describe("the surface redraws from authoritative state, not from a calendar snapshot", () => {
  /** The two sources `reload` chooses between, and what it did with them. */
  function sources(server: unknown, cache: unknown) {
    return { server, cache, reads: [] as string[], draws: [] as unknown[], activityLoads: 0 };
  }

  /**
   * MUTATION THAT MUST FAIL THIS: put `calendarAppointmentById(id) ||` back in front of the read.
   *
   * This is the race the owner hit. `reopenReceipt` fires `refresh()` DETACHED after a void while
   * the Invoice workspace's `onClose` awaits this reload, so at the moment the footer is redrawn
   * the calendar may still be holding the pre-void row - `paid`, nothing due - over an invoice
   * that has just gone back to `Open` with $79.01 owing.
   */
  it("takes the server's answer over a calendar row a concurrent refresh has not replaced", async () => {
    const client = loadClient();
    client.grant("checkout.perform", "payments.view");
    const surface = settledSurface();
    const stale = { ...surface.item };
    const fresh = { ...surface.item, invoiceStatus: "open", invoiceBalanceMinor: 7901 };
    const recorded = sources(fresh, stale);

    await client.reloadSurface(surface, String(surface.item.id), recorded);

    expect(recorded.reads).toEqual([`/api/appointments/${surface.item.id}`]);
    expect(surface.item).toMatchObject({ invoiceStatus: "open", invoiceBalanceMinor: 7901 });
    // And the footer that follows offers the money, which is the whole point of asking.
    expect(client.derivePermissions(surface)).toMatchObject({ checkout: true, invoice: true });
    expect(recorded.draws).toHaveLength(1);
    expect(recorded.activityLoads).toBe(1);
  });

  it("falls back to the calendar row when the read fails, rather than blanking the surface", async () => {
    // An operator standing on this surface keeps what they were looking at. Redrawing from a stale
    // appointment is worse than redrawing from a fresh one and better than redrawing from nothing.
    const client = loadClient();
    const surface = voidedSurface();
    const cached = { ...surface.item, invoiceBalanceMinor: 5201, invoiceStatus: "partially_paid" };
    const recorded = sources(null, cached);

    await client.reloadSurface(surface, String(surface.item.id), recorded);

    expect(recorded.reads).toEqual([`/api/appointments/${surface.item.id}`]);
    expect(surface.item).toMatchObject({ invoiceStatus: "partially_paid" });
    expect(recorded.draws).toHaveLength(1);
  });

  it("redraws what it already had when neither source answers", async () => {
    const client = loadClient();
    const surface = voidedSurface();
    const before = surface.item;
    const recorded = sources(null, null);

    await client.reloadSurface(surface, String(surface.item.id), recorded);

    expect(surface.item).toBe(before);
    expect(recorded.draws).toEqual([before]);
  });
});
