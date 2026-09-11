import { describe, expect, it } from "vitest";
import { dialogHarness, evaluate, slice, type DialogHarness } from "./support/stacked-dialog.js";

/**
 * A DOCUMENT IS SEEN BEFORE IT IS PRINTED, AND ONLY PRESSING PRINT PRINTS IT.
 *
 * Print Invoice, Print Receipt and the Ticket's own Print used to hand the operator straight to
 * the browser's print dialog. There was no way to see what was about to come out of the printer,
 * and no way back to the screen they pressed it from except that dialog's Cancel — which is the
 * browser's control, not Pawsh's, and lands wherever the browser decides.
 *
 * The agenda has never worked that way: `openPrintAgenda` draws the document into
 * `#print-agenda-preview` and reaches `appendPrintRoot` only when the operator presses Print. That
 * precedent is now the rule, and `previewPrintRoot` is where it lives. The agenda keeps its own
 * preview and still reaches `appendPrintRoot` directly, so it is NOT one of the documents this
 * file holds: the three that come through `previewPrintRoot` are the Invoice, the Receipt and the
 * Ticket.
 *
 * ─── THE ONE PROPERTY THAT MATTERS MOST ──────────────────────────────────────────────────────
 *
 * WHAT REACHES PAPER MUST NOT HAVE CHANGED. `previewPrintRoot` takes exactly the two arguments
 * `appendPrintRoot` takes and hands those same two values straight back to it, so there is no
 * second composition step for the preview and the paper to drift between — and now no third
 * argument either: the chrome is generic, so there is nothing for a caller to name it with.
 * The assertion that holds this is `the preview body CONTAINS the printed innerHTML, verbatim`:
 * a preview that reformatted, trimmed, re-escaped or re-titled the document on its way to the
 * screen would stop containing what was later appended, and the class that says WHICH document
 * it is travels with it.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `previewPrintRoot(className,html)` → `appendPrintRoot(className,html)`
 *       the two entry points print immediately again. Every "opens a preview and prints nothing"
 *       assertion below fails, in all three documents.
 *
 *   `onConfirm:()=>{}` in `previewPrintRoot`
 *       Print becomes furniture. "confirming is what reaches paper" fails.
 *
 *   dropping `headCloseLabel` from `previewPrintRoot`
 *       there is no X to return to the previous window with. "the head X closes it" fails.
 *
 *   `title:`Print preview: ${documentTitle}`` in `previewPrintRoot`, naming the document again
 *       the chrome repeats the name the document already carries a centimetre below it. Every
 *       assertion in "the preview chrome carries no document label" fails.
 *
 *   `title:""` in `previewPrintRoot`
 *       the heading is `aria-labelledby` for the dialog, so an empty one announces the modal as
 *       nothing at all. "the heading is not empty" fails. Removing the REDUNDANT label is not the
 *       same change as removing the dialog's accessible name.
 */

/** The mechanism itself: the root that reaches paper, and the preview in front of it. */
const MECHANISM = slice("function appendPrintRoot(", "\n// THE INVOICE, IN EVERY SETTLEMENT STATE.");
/** The dialog the preview is drawn in, executed rather than described. */
const DIALOG = slice("function openStackedDialog({", "\n// Pets whose rabies record has already lapsed");
/** The Invoice's and the Receipt's shared composition step. */
const FINANCIAL = slice("function printFinancialRoot(", "\n/**\n * THE PRINTING MECHANISM ITSELF");
/** The Ticket's own path to paper. */
const TICKET = slice("function printTicket(item,notes){", "\n/**\n * Opens the Ticket.");

/**
 * The two bodies, as sentinels. Three documents share them, because the Invoice and the Receipt
 * are one composition step handed a different title and a different root class. What each document
 * SAYS is held by its own spec — this file is about the step in front of it — so each is a string
 * distinctive enough that finding it on paper proves which document was composed.
 */
const INVOICE_BODY = '<section data-testid="receipt">«what the visit cost»</section>';
const TICKET_SENTINEL = '<div data-testid="ticket-document">«the shop’s work sheet»</div>';

interface Client {
  printFinancialRoot(title: string, body: string, className: string): void;
  printTicket(item: unknown, notes: unknown): void;
  previewPrintRoot(className: string, html: string): unknown;
  openStackedDialog(options: Record<string, unknown>): unknown;
}

function loadClient(): { client: Client; dialog: DialogHarness } {
  const dialog = dialogHarness();
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const client = evaluate<Client>(
    [MECHANISM, DIALOG, FINANCIAL, TICKET],
    {
      ...dialog.stubs,
      escape,
      escapeAttr: (value = "") =>
        escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;"),
      // The Ticket's body, as a sentinel. What it actually SAYS — that it opens on its own
      // reference and the salon's name, which is what lets the chrome carry no label — is
      // `tests/ui/ticket-document.test.ts`, against the real renderer.
      ticketDocumentMarkup: () => TICKET_SENTINEL
    },
    `return {printFinancialRoot, printTicket, previewPrintRoot, openStackedDialog};`
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
    // The chrome names no document: three words, and the two controls. The name is in the body.
    expect(preview?.title).toBe("Print preview");
    expect(preview?.confirmLabel).toBe("Print");
    expect(preview?.dismissLabel).toBe("Close");
    // The document itself, on screen: its own title and its own body.
    expect(previewedDocument(preview!.body)).toBe(`<h1>Invoice #1042</h1>${INVOICE_BODY}`);
  });

  it("previews the Receipt and prints NOTHING until Print is pressed", () => {
    // The Receipt is its own document even though it shares `printFinancialRoot` with the Invoice:
    // a different title, and `print-payment-receipt` on the root to tell the two apart on paper.
    // Nothing reaches paper for this one either until Print is pressed.
    const { client, dialog } = loadClient();
    client.printFinancialRoot("Receipt #1042", INVOICE_BODY, "print-root print-payment-receipt");

    expect(dialog.printed).toEqual([]);
    expect(dialog.prints.count).toBe(0);
    expect(dialog.isOpen()).toBe(true);
    const preview = dialog.current();
    expect(preview?.title).toBe("Print preview");
    expect(preview?.confirmLabel).toBe("Print");
    expect(preview?.dismissLabel).toBe("Close");
    expect(previewedDocument(preview!.body)).toBe(`<h1>Receipt #1042</h1>${INVOICE_BODY}`);
  });

  it("previews the Ticket and prints NOTHING until Print is pressed", () => {
    const { client, dialog } = loadClient();
    client.printTicket({ id: "4f2c1a90-0000-4000-8000-000000000001" }, { pet: null, client: null });

    expect(dialog.printed).toEqual([]);
    expect(dialog.prints.count).toBe(0);
    expect(previewedDocument(dialog.current()!.body)).toBe(TICKET_SENTINEL);
  });
});

describe("the preview chrome carries no document label", () => {
  /**
   * THE DOCUMENT NAMES ITSELF, SO THE WINDOW OVER IT DOES NOT HAVE TO.
   *
   * For a while every preview was headed `Print preview: Invoice #1042`, standing over a body
   * headed `Invoice #1042` a centimetre below. Saying it twice in two lines is not twice as clear:
   * it is a row of the window spent on the one thing the window was already showing, and the
   * preview is the one place in the product where both readings are on screen at once. So the
   * chrome is the two controls an operator needs — Close, to get back to whatever opened it, and
   * Print — and a generic heading that names no document.
   *
   * THE PRECONDITION IS THAT EVERY BODY NAMES ITSELF, and it is asserted rather than assumed.
   * `printFinancialRoot` prepends the Invoice's and the Receipt's <h1>, and the Ticket's body
   * opens on `Appointment #: ...` and the salon's name — which this file cannot see, because it
   * stubs `ticketDocumentMarkup` to a sentinel, so `tests/ui/ticket-document.test.ts` holds that
   * half against the real renderer.
   */
  it("heads every preview with the same three words, whichever document it is holding", () => {
    const invoice = loadClient();
    invoice.client.printFinancialRoot("Invoice #1042", INVOICE_BODY, "print-root");
    expect(invoice.dialog.current()?.title).toBe("Print preview");

    const receipt = loadClient();
    receipt.client.printFinancialRoot(
      "Receipt #1042", INVOICE_BODY, "print-root print-payment-receipt"
    );
    expect(receipt.dialog.current()?.title).toBe("Print preview");

    const ticket = loadClient();
    ticket.client.printTicket(
      { id: "4f2c1a90-0000-4000-8000-000000000001" }, { pet: null, client: null }
    );
    expect(ticket.dialog.current()?.title).toBe("Print preview");
  });

  it("names no document in the chrome — not the Invoice, the Receipt or the Ticket", () => {
    // The specific regression: a heading that carries the document's name AS WELL AS the three
    // words would pass an assertion that only checked the three words were still there.
    const invoice = loadClient();
    invoice.client.printFinancialRoot("Invoice #1042", INVOICE_BODY, "print-root");
    expect(invoice.dialog.current()?.title).not.toContain("1042");
    expect(invoice.dialog.current()?.title).not.toContain("Invoice");

    const receipt = loadClient();
    receipt.client.printFinancialRoot(
      "Receipt #1042", INVOICE_BODY, "print-root print-payment-receipt"
    );
    expect(receipt.dialog.current()?.title).not.toContain("Receipt");
    expect(receipt.dialog.current()?.title).not.toContain("1042");

    const ticket = loadClient();
    ticket.client.printTicket(
      { id: "4f2c1a90-0000-4000-8000-000000000001" }, { pet: null, client: null }
    );
    expect(ticket.dialog.current()?.title).not.toContain("Ticket");
    expect(ticket.dialog.current()?.title).not.toContain("4f2c1a90");
  });

  it("puts the name INSIDE the preview instead, where the document prints it", () => {
    // What was lost from the chrome was never lost from the screen. The <h1> the body is handed is
    // the <h1> that reaches paper, so the preview shows the document's name in the place the
    // document actually carries it.
    const invoice = loadClient();
    invoice.client.printFinancialRoot("Invoice #1042", INVOICE_BODY, "print-root");
    expect(previewedDocument(invoice.dialog.current()!.body))
      .toBe(`<h1>Invoice #1042</h1>${INVOICE_BODY}`);

    const receipt = loadClient();
    receipt.client.printFinancialRoot(
      "Receipt #1042", INVOICE_BODY, "print-root print-payment-receipt"
    );
    expect(previewedDocument(receipt.dialog.current()!.body))
      .toBe(`<h1>Receipt #1042</h1>${INVOICE_BODY}`);

    // The Ticket prepends NOTHING, here as before: its own body is its own title, which is why
    // the chrome's label was safe to drop for this document too.
    const ticket = loadClient();
    ticket.client.printTicket(
      { id: "4f2c1a90-0000-4000-8000-000000000001" }, { pet: null, client: null }
    );
    expect(previewedDocument(ticket.dialog.current()!.body)).not.toContain("<h1>");
  });

  it("keeps a heading at all, because it is the dialog's accessible name", () => {
    // `#stacked-dialog` is `aria-labelledby="stacked-dialog-title"`. Removing the REDUNDANT label
    // is not the same change as emptying the heading: a modal with no accessible name announces
    // as nothing, and that is a worse trade than a generic name.
    const { client, dialog } = loadClient();
    client.printFinancialRoot("Invoice #1042", INVOICE_BODY, "print-root");
    expect(dialog.current()?.title).toBeTruthy();
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
    expect(loadedInvoice.dialog.printed[0]!.innerHTML)
      .toBe(`<h1>Invoice #1042</h1>${INVOICE_BODY}`);

    const loadedReceipt = loadClient();
    loadedReceipt.client.printFinancialRoot(
      "Receipt #1042", INVOICE_BODY, "print-root print-payment-receipt"
    );
    await loadedReceipt.dialog.confirm();
    expect(loadedReceipt.dialog.opens[0]!.body)
      .toContain(loadedReceipt.dialog.printed[0]!.innerHTML);
    expect(loadedReceipt.dialog.printed[0]!.innerHTML)
      .toBe(`<h1>Receipt #1042</h1>${INVOICE_BODY}`);
    // The class is what tells the Receipt from the Invoice on paper, and it survives the preview.
    expect(loadedReceipt.dialog.printed[0]!.className).toBe("print-root print-payment-receipt");
    expect(loadedReceipt.dialog.opens[0]!.body)
      .toContain('data-print-root-class="print-root print-payment-receipt"');

    const loadedTicket = loadClient();
    loadedTicket.client.printTicket(
      { id: "4f2c1a90-0000-4000-8000-000000000001" }, { pet: null, client: null }
    );
    await loadedTicket.dialog.confirm();
    expect(loadedTicket.dialog.opens[0]!.body)
      .toContain(loadedTicket.dialog.printed[0]!.innerHTML);
    expect(loadedTicket.dialog.printed[0]!.className).toBe("print-root print-ticket");
    expect(loadedTicket.dialog.printed[0]!.innerHTML).toBe(TICKET_SENTINEL);
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
    // The Receipt, so that the three ways out of a preview are each proved against a different one
    // of the three documents rather than all three against the same one.
    const { client, dialog } = loadClient();
    client.printFinancialRoot("Receipt #1042", INVOICE_BODY, "print-root print-payment-receipt");
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
