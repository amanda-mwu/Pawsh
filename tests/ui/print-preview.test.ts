import { describe, expect, it } from "vitest";
import { dialogHarness, evaluate, slice, type DialogHarness } from "./support/stacked-dialog.js";

/**
 * A DOCUMENT IS SEEN BEFORE IT IS PRINTED, AND ONLY PRESSING PRINT PRINTS IT.
 *
 * Print Invoice, Print Receipt, Ticket and Print used to hand the operator straight to the
 * browser's own print dialog. There was no way to see what was about to come out of the printer,
 * and no way back to the screen they pressed it from except that dialog's Cancel — which is the
 * browser's control, not Pawsh's, and lands wherever the browser decides.
 *
 * The agenda has never worked that way: `openPrintAgenda` draws the document into
 * `#print-agenda-preview` and reaches `appendPrintRoot` only when the operator presses Print. That
 * precedent is now the rule, and `previewPrintRoot` is where it lives.
 *
 * ─── THE ONE PROPERTY THAT MATTERS MOST ──────────────────────────────────────────────────────
 *
 * WHAT REACHES PAPER MUST NOT HAVE CHANGED. `previewPrintRoot` takes the two arguments
 * `appendPrintRoot` takes and hands those same two values straight back to it, so there is no
 * second composition step for the preview and the paper to drift between. Its third argument is
 * the document's NAME and reaches the window's heading only — it is never composed into the
 * markup and never reaches `appendPrintRoot`, so naming the preview cannot change a document.
 * The assertion that holds this is `the preview body CONTAINS the printed innerHTML, verbatim`:
 * a preview that reformatted, trimmed, re-escaped or re-titled the document on its way to the
 * screen would stop containing what was later appended, and the class that says WHICH document
 * it is travels with it.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `previewPrintRoot(className,html)` → `appendPrintRoot(className,html)`
 *       the four entry points print immediately again. Every "opens a preview and prints nothing"
 *       assertion below fails, in all four documents.
 *
 *   `onConfirm:()=>{}` in `previewPrintRoot`
 *       Print becomes furniture. "confirming is what reaches paper" fails.
 *
 *   dropping `headCloseLabel` from `previewPrintRoot`
 *       there is no X to return to the previous window with. "the head X closes it" fails.
 *
 *   `title:"Print preview"` in `previewPrintRoot`, ignoring the document it was given
 *       the window over the document stops naming the document. Every assertion in
 *       "the preview names the document it is holding" fails, and the Ticket's fails hardest:
 *       the Ticket body carries no <h1> at all, so with a fixed title NOTHING on screen said
 *       which document was about to be printed.
 */

/** The mechanism itself: the root that reaches paper, and the preview in front of it. */
const MECHANISM = slice("function appendPrintRoot(", "\n// THE INVOICE, IN EVERY SETTLEMENT STATE.");
/** The dialog the preview is drawn in, executed rather than described. */
const DIALOG = slice("function openStackedDialog({", "\n// Pets whose rabies record has already lapsed");
/** The Invoice's and the Receipt's shared composition step. */
const FINANCIAL = slice("function printFinancialRoot(", "\n/**\n * THE PRINTING MECHANISM ITSELF");
/** The Ticket's own path to paper. */
const TICKET = slice("function printTicket(item,notes){", "\n/**\n * Opens the Ticket.");
/** One appointment, printed off the detail surface. */
const APPOINTMENT = slice("function printAppointment(item){", "\n/**\n * Two notes, two audiences");

/**
 * The three bodies, as sentinels. What each document SAYS is held by its own spec — this file is
 * about the step in front of it — so each is a string distinctive enough that finding it on paper
 * proves which document was composed.
 */
const INVOICE_BODY = '<section data-testid="receipt">«what the visit cost»</section>';
const TICKET_SENTINEL = '<div data-testid="ticket-document">«the shop’s work sheet»</div>';
const AGENDA_SENTINEL = '<article class="print-appointment">«one visit»</article>';

interface Client {
  printFinancialRoot(title: string, body: string, className: string): void;
  printTicket(item: unknown, notes: unknown): void;
  printAppointment(item: unknown): void;
  previewPrintRoot(className: string, html: string, documentTitle?: string): unknown;
  openStackedDialog(options: Record<string, unknown>): unknown;
}

function loadClient(): { client: Client; dialog: DialogHarness } {
  const dialog = dialogHarness();
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const client = evaluate<Client>(
    [MECHANISM, DIALOG, FINANCIAL, TICKET, APPOINTMENT],
    {
      ...dialog.stubs,
      escape,
      escapeAttr: (value = "") =>
        escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;"),
      ticketDocumentMarkup: () => TICKET_SENTINEL,
      // Eight hex characters of the appointment id, exactly as the client derives it. The
      // Ticket's preview is titled by it, so a stub that invented a reference would let a
      // preview that named the wrong document pass.
      ticketReference: (item: { id: string }) => String(item.id).slice(0, 8),
      printableAgenda: () => AGENDA_SENTINEL
    },
    `return {printFinancialRoot, printTicket, printAppointment, previewPrintRoot, openStackedDialog};`
  );
  return { client, dialog };
}

/** What the preview drew, without the frame `previewPrintRoot` wraps it in. */
function previewedDocument(body: string): string {
  const opened = body.indexOf(">", body.indexOf("<section class=\"print-preview\""));
  return body.slice(opened + 1, body.lastIndexOf("</section>"));
}

describe("every printable document opens a preview instead of the browser's print dialog", () => {
  it("previews the Invoice and prints NOTHING until Print is pressed", () => {
    const { client, dialog } = loadClient();
    client.printFinancialRoot("Invoice #1042", INVOICE_BODY, "print-root");

    expect(dialog.printed).toEqual([]);
    expect(dialog.prints.count).toBe(0);
    expect(dialog.isOpen()).toBe(true);
    const preview = dialog.current();
    expect(preview?.title).toBe("Print preview: Invoice #1042");
    expect(preview?.confirmLabel).toBe("Print");
    expect(preview?.dismissLabel).toBe("Close");
    // The document itself, on screen: its own title and its own body.
    expect(previewedDocument(preview!.body)).toBe(`<h1>Invoice #1042</h1>${INVOICE_BODY}`);
  });

  it("previews the Ticket and prints NOTHING until Print is pressed", () => {
    const { client, dialog } = loadClient();
    client.printTicket({ id: "4f2c1a90-0000-4000-8000-000000000001" }, { pet: null, client: null });

    expect(dialog.printed).toEqual([]);
    expect(dialog.prints.count).toBe(0);
    expect(previewedDocument(dialog.current()!.body)).toBe(TICKET_SENTINEL);
  });

  it("previews one appointment and prints NOTHING until Print is pressed", () => {
    const { client, dialog } = loadClient();
    client.printAppointment({ id: "appt" });

    expect(dialog.printed).toEqual([]);
    expect(dialog.prints.count).toBe(0);
    expect(previewedDocument(dialog.current()!.body))
      .toBe(`<h1>Pawsh appointment</h1>${AGENDA_SENTINEL}`);
  });
});

describe("the preview names the document it is holding", () => {
  /**
   * THE WINDOW OVER A DOCUMENT HAS TO SAY WHICH DOCUMENT IT IS HOLDING.
   *
   * Every preview was headed the same three words, so the only thing on screen that named the
   * document was the <h1> inside the scroller - and the Ticket prepends no <h1>, so for the
   * Ticket nothing named it at all. An operator who reached for Print Receipt and is looking at
   * a window headed `Invoice #1042` has been told they pressed the wrong control BEFORE the
   * paper comes out, which is the whole point of there being a preview.
   *
   * The name is the one the document carries everywhere else in its life - `invoiceDocumentTitle`
   * for the Invoice, `paymentReceiptTitle` for the Receipt, the Ticket's own reference - so the
   * preview cannot call a document anything the rest of the product does not.
   */
  it("heads the Invoice preview with the Invoice, and the Receipt preview with the Receipt", () => {
    const invoice = loadClient();
    invoice.client.printFinancialRoot("Invoice #1042", INVOICE_BODY, "print-root");
    expect(invoice.dialog.current()?.title).toBe("Print preview: Invoice #1042");

    const receipt = loadClient();
    receipt.client.printFinancialRoot(
      "Receipt #1042", INVOICE_BODY, "print-root print-payment-receipt"
    );
    expect(receipt.dialog.current()?.title).toBe("Print preview: Receipt #1042");
  });

  it("heads the Ticket preview with the Ticket reference, which its body never carries", () => {
    const { client, dialog } = loadClient();
    client.printTicket({ id: "4f2c1a90-0000-4000-8000-000000000001" }, { pet: null, client: null });
    expect(dialog.current()?.title).toBe("Print preview: Ticket #: 4f2c1a90");
    // And the body still carries no title of its own, so the window is the only thing naming it.
    expect(previewedDocument(dialog.current()!.body)).not.toContain("<h1>");
  });

  it("heads the appointment preview with the appointment", () => {
    const { client, dialog } = loadClient();
    client.printAppointment({ id: "appt" });
    expect(dialog.current()?.title).toBe("Print preview: Pawsh appointment");
  });

  it("still says it is a preview, so the window is not mistaken for the document", () => {
    // The identity was ADDED to the window's name, not swapped for it. A dialog headed only
    // `Invoice #1042`, standing over a workspace headed `Invoice #1042`, would read as the
    // same thing twice rather than as a picture of one about to be printed.
    const { client, dialog } = loadClient();
    client.printFinancialRoot("Invoice #1042", INVOICE_BODY, "print-root");
    expect(dialog.current()?.title).toContain("Print preview");
  });
});

describe("Print, and only Print, reaches paper", () => {
  it("appends exactly one root and asks the browser once", async () => {
    const { client, dialog } = loadClient();
    client.printFinancialRoot("Invoice #1042", INVOICE_BODY, "print-root");
    await dialog.confirm();

    expect(dialog.printed).toHaveLength(1);
    expect(dialog.printed[0]!.className).toBe("print-root");
    expect(dialog.prints.count).toBe(1);
    // The unchanged mechanism, still tearing its root down a second later.
    expect(dialog.timers).toHaveLength(1);
    // And the preview is gone, so the operator is back on the Invoice they pressed it from.
    expect(dialog.isOpen()).toBe(false);
  });

  it("puts on paper the VERY MARKUP it previewed, for every document", async () => {
    // THE DRIFT ASSERTION. `previewPrintRoot` hands `appendPrintRoot` the same two values it drew,
    // so the printed document is a substring of the preview body, character for character. A
    // preview that recomposed the document on its way to the screen would stop containing it.
    const loadedInvoice = loadClient();
    loadedInvoice.client.printFinancialRoot("Invoice #1042", INVOICE_BODY, "print-root");
    await loadedInvoice.dialog.confirm();
    expect(loadedInvoice.dialog.opens[0]!.body)
      .toContain(loadedInvoice.dialog.printed[0]!.innerHTML);

    const loadedReceipt = loadClient();
    loadedReceipt.client.printFinancialRoot(
      "Receipt #1042", INVOICE_BODY, "print-root print-payment-receipt"
    );
    await loadedReceipt.dialog.confirm();
    expect(loadedReceipt.dialog.opens[0]!.body)
      .toContain(loadedReceipt.dialog.printed[0]!.innerHTML);
    // The class is what tells the Receipt from the Invoice on paper, and it survives the preview.
    expect(loadedReceipt.dialog.printed[0]!.className).toBe("print-root print-payment-receipt");
    expect(loadedReceipt.dialog.opens[0]!.body)
      .toContain('data-print-root-class="print-root print-payment-receipt"');

    const loadedTicket = loadClient();
    loadedTicket.client.printTicket(
      { id: "4f2c1a90-0000-4000-8000-000000000001" }, { pet: null, client: null }
    );
    await loadedTicket.dialog.confirm();
    expect(loadedTicket.dialog.printed[0]!.className).toBe("print-root print-ticket");
    expect(loadedTicket.dialog.printed[0]!.innerHTML).toBe(TICKET_SENTINEL);

    const loadedAppointment = loadClient();
    loadedAppointment.client.printAppointment({ id: "appt" });
    await loadedAppointment.dialog.confirm();
    expect(loadedAppointment.dialog.printed[0]!.innerHTML)
      .toBe(`<h1>Pawsh appointment</h1>${AGENDA_SENTINEL}`);
  });
});

describe("closing the preview returns to the window underneath, having printed nothing", () => {
  it("Close prints nothing", async () => {
    const { client, dialog } = loadClient();
    client.printTicket({ id: "4f2c1a90-0000-4000-8000-000000000001" }, { pet: null, client: null });
    await dialog.dismiss();

    expect(dialog.isOpen()).toBe(false);
    expect(dialog.printed).toEqual([]);
    expect(dialog.prints.count).toBe(0);
  });

  it("the head X prints nothing — and it is the same dismissal Close is", async () => {
    const { client, dialog } = loadClient();
    client.printFinancialRoot("Invoice #1042", INVOICE_BODY, "print-root");
    expect(dialog.current()?.headCloseLabel).toBe("Close print preview");

    await dialog.headClose();
    expect(dialog.isOpen()).toBe(false);
    expect(dialog.printed).toEqual([]);
    expect(dialog.prints.count).toBe(0);
  });

  it("Escape prints nothing", () => {
    const { client, dialog } = loadClient();
    client.printAppointment({ id: "appt" });
    dialog.escape();

    expect(dialog.isOpen()).toBe(false);
    expect(dialog.printed).toEqual([]);
    expect(dialog.prints.count).toBe(0);
  });
});

describe("the head X belongs to the dialog that asked for one", () => {
  it("is not inherited by the next stacked dialog", () => {
    // The X is appended to the heading, and the heading's text is reassigned on every open. A
    // question-shaped stacked dialog — the pet picker, the refund, the void reason — must not
    // inherit a close control from a preview that stood there a moment ago.
    const { client, dialog } = loadClient();
    client.printFinancialRoot("Invoice #1042", INVOICE_BODY, "print-root");
    expect(dialog.opens[0]!.headCloseLabel).toBe("Close print preview");

    client.openStackedDialog({
      title: "Select pet for appointment",
      body: '<div class="stacked-dialog-options"></div>',
      dismissLabel: "Cancel",
      confirmLabel: "OK"
    });
    expect(dialog.opens[1]!.headCloseLabel).toBeNull();
  });
});
