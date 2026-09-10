import { test, expect, login, completeAppointment, createAppointment } from "./fixtures/tenant.js";
import { openCheckout, chooseMethod, setPayAmount, checkoutSurface } from "./helpers/checkout.js";
import { observePrinting, clearPrintRoots } from "./helpers/print.js";
import type { APIRequestContext, Dialog, Page } from "@playwright/test";

/**
 * PAYMENT CHANGES AN INVOICE'S SETTLEMENT STATE, NOT ITS DOCUMENT IDENTITY.
 *
 * Four documents, and only one of them is evidence of payment:
 *
 *   Ticket   the CRM document for the visit — who, which pet, which services. No money at all.
 *   Invoice  a financial obligation. It exists the moment the visit is billed and it can owe
 *            money for as long as nobody pays it. IT REMAINS AN INVOICE ONCE PAID.
 *   Payment  ONE TENDER COMPONENT of a settlement against an invoice.
 *   Receipt  a SEPARATE document evidencing the COMPLETED settlement, never a payment on its own.
 *
 * There used to be one printable financial page under two names: `Invoice #1042` while nothing had
 * been paid, `Receipt #1042` the moment anything had. Both halves of that were wrong, and this
 * spec is the ladder that holds the correction.
 *
 *   - A paid invoice opened from a client's transaction history is still headed `Invoice #1042`.
 *     Settlement moves the balance and adds a payment record; neither is a change of document.
 *   - Print Invoice is offered in EVERY settlement state, because a settled visit still has a bill
 *     and a client may still ask for it. It used to disappear at the first payment.
 *   - Print Receipt appears BESIDE it once the settlement has COMPLETED, never instead of it, and
 *     never at all before. A Receipt is evidence of a settlement that finished, so an invoice
 *     still carrying a balance has none: the obligation is the Invoice's to state, and the Invoice
 *     is printable throughout. It renders the Receipt — the settlement's TENDER COMPOSITION, what
 *     was taken, how, when and under what reference — and never the Ticket.
 *   - ONE INVOICE PER APPOINTMENT, ONE COMPLETED SETTLEMENT PER INVOICE, AND A SETTLEMENT MAY USE
 *     SEVERAL TENDER COMPONENTS. Two payments settling one invoice are two components of one
 *     settlement, and the Receipt presents them as a composition adding to `Total settled` — never
 *     as "Payment 1 of 2", which framed one settlement as a series of independent checkouts.
 *
 * The money statement itself stays SHARED: `receiptBodyMarkup` renders the invoice's figures for
 * the modal, the settled Check Out panel and the Invoice print root, and
 * `tests/e2e/ticket-surface.spec.ts` holds the single-money-statement invariant across those
 * three. The Receipt is not a fourth host for it — it states no subtotal, discount, tax, tip or
 * invoice total — which is exactly why it is a different document rather than a different title.
 * The renderer's own truthfulness rules are held against fixtures in
 * `tests/ui/payment-receipt.test.ts`; this spec walks the states a browser can reach.
 */

const printRoot = (page: Page) => page.locator(".print-root");

/** Raises the invoice through the API, so the figures are fixed before the browser sees them. */
async function raiseInvoice(api: APIRequestContext, appointmentId: string): Promise<{
  id: string; invoiceNumber: number; balanceMinor: number;
}> {
  const response = await api.post(`/api/appointments/${appointmentId}/checkout`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { discountMinor: 500, discountType: "manual", tipMinor: 1500 }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { id: string; invoiceNumber: number; balanceMinor: number };
}

/**
 * Opens Check Out from the calendar, on a calendar that has already settled.
 *
 * Reloaded rather than re-navigated: each step of the ladder below changes the invoice through the
 * API, and clicking Calendar while already on it redraws the cards under the action menu the click
 * is aiming at.
 */
async function reopenCheckout(page: Page, appointmentId: string) {
  await page.reload();
  await expect(page.locator("#app-view")).toBeVisible();
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  return openCheckout(page, appointmentId);
}

test("an Invoice stays an Invoice, and a Receipt appears beside it once a payment is recorded",
  async ({ page, request, tenant }) => {
    await observePrinting(page);
    const appointment = await completeAppointment(request, tenant);
    await login(page, tenant.ownerEmail);

    // ---- 1. Completed visit, NO INVOICE -------------------------------------------------
    // Nothing financial exists to print, so neither document is offered. The Ticket is, and it is
    // reached from the appointment surface rather than from here — see ticket-surface.spec.ts.
    const building = await reopenCheckout(page, appointment.id);
    await expect(building.getByTestId("checkout-print-receipt")).toHaveCount(0);
    await expect(building.getByTestId("checkout-print-invoice")).toHaveCount(0);
    // The Ticket is a CRM document and needs no invoice, so it is here in every mode.
    await expect(building.getByTestId("checkout-ticket")).toBeVisible();
    // Closed the way an operator closes it. Nothing was typed, so the surface's dirty guard has
    // nothing to challenge.
    await building.locator("[data-surface-close]").click();
    await expect(checkoutSurface(page)).toBeHidden();

    // ---- 2. INVOICE, NO PAYMENT ----------------------------------------------------------
    const invoice = await raiseInvoice(request, appointment.id);
    const owing = await reopenCheckout(page, appointment.id);
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $101.60");
    // NO PRINT RECEIPT AND NO SEND RECEIPT. The financial view is valid and shows what is owed;
    // what it must not do is offer evidence of a payment nobody made.
    await expect(owing.getByTestId("checkout-print-receipt")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /send receipt/iu })).toHaveCount(0);
    // The printable document still exists — an operator hands a client the bill — and it says
    // exactly what it is.
    await expect(owing.getByTestId("checkout-print-invoice")).toBeVisible();
    await owing.getByTestId("checkout-print-invoice").click();
    await expect(printRoot(page).locator("h1")).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    await expect(printRoot(page)).toContainText("No payment recorded.");
    // THE SALON'S OWN IDENTITY AT THE HEAD OF IT, the same block the Ticket prints and through the
    // same renderer — ADR-011 asks for one helper so the documents cannot drift. A label with
    // nothing after it is never drawn, and this fixture happens to prove both halves of that rule
    // at once: signup writes the owner's address onto the business, so the Email line IS drawn and
    // carries it, while nothing ever writes the phone or the location's address and those two
    // labels are absent entirely rather than standing empty. The all-four-fields case is held
    // against the real renderer in `tests/ui/receipt-salon-identity.test.ts`; the payload side is
    // in `tests/database/tender-amount-and-receipt.test.ts`.
    const invoiceSalon = printRoot(page).getByTestId("receipt-salon");
    await expect(invoiceSalon).toContainText(`PW Smoke ${tenant.runId}`);
    await expect(invoiceSalon).toContainText("Email:");
    await expect(invoiceSalon).toContainText(tenant.ownerEmail);
    await expect(invoiceSalon).not.toContainText("Phone:");
    await expect(invoiceSalon).not.toContainText("Address:");
    await clearPrintRoots(page);

    // ---- 3. SETTLEMENT IN PROGRESS: THE BILL, AND NOT YET THE EVIDENCE ---------------------
    await chooseMethod(page, "Cash");
    await setPayAmount(page, "40.00");
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $61.60");
    const partial = checkoutSurface(page);
    // THE BILL DID NOT GO ANYWHERE. This is the regression the old mutually-exclusive footer had:
    // one payment against a $101.60 invoice removed the operator's only way to print the invoice.
    await expect(partial.getByTestId("checkout-print-invoice")).toBeVisible();
    // AND THE EVIDENCE IS NOT HERE YET. $40.00 of $101.60 is a recorded COMPONENT of a settlement
    // that has not completed; a Receipt handed over now would evidence a settlement that has not
    // happened. Absent rather than disabled — there is no document to disable.
    await expect(partial.getByTestId("checkout-print-receipt")).toHaveCount(0);
    // The surface says which of the two states it is in, rather than leaving a smaller balance as
    // the only sign that anything happened.
    await expect(partial.getByTestId("checkout-settlement-progress"))
      .toHaveText("Settlement in progress · $40.00 recorded · $61.60 still to settle");

    await partial.getByTestId("checkout-print-invoice").click();
    await expect(printRoot(page).locator("h1")).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    // Still the whole statement, and still stating what is owed — which is the document that is
    // supposed to say that, and the reason the Receipt does not have to.
    await expect(printRoot(page).locator(".receipt")).toContainText("Balance$61.60");
    // The payment that HAS landed is on the bill's own history, so nothing about it is hidden;
    // what is withheld is the document that would call the settlement finished.
    await expect(printRoot(page).locator(".receipt")).toContainText("Cash");
    await expect(printRoot(page).getByTestId("payment-receipt")).toHaveCount(0);
    await clearPrintRoots(page);

    // ---- 4. THE SETTLEMENT COMPLETES: BOTH DOCUMENTS, NEITHER REPLACING THE OTHER -----------
    await chooseMethod(page, "Cash");
    await setPayAmount(page, "61.60");
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $0.00");
    const settled = checkoutSurface(page);
    await expect(settled.getByTestId("checkout-done")).toBeVisible();
    await expect(settled.getByTestId("checkout-settlement-progress")).toHaveCount(0);
    await expect(settled.getByTestId("checkout-print-receipt")).toBeVisible();
    await expect(settled.getByTestId("checkout-print-invoice")).toBeVisible();

    await settled.getByTestId("checkout-print-invoice").click();
    await expect(printRoot(page).locator("h1")).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    await clearPrintRoots(page);

    // ONE SETTLEMENT, TWO TENDER COMPONENTS. The invoice was settled two ways and the Receipt is
    // the COMPOSITION of that one settlement — never a series the client is asked to count
    // through, and never one fused $101.60 payment that no row in `payments` corresponds to.
    await settled.getByTestId("checkout-print-receipt").click();
    const receiptDoc = printRoot(page).getByTestId("payment-receipt");
    await expect(printRoot(page).locator("h1")).toHaveText(`Receipt #${invoice.invoiceNumber}`);
    // PRESENT, not "visible". `.print-root{display:none}` (styles.css) keeps every print document
    // off the screen and `@media print` is the only thing that reveals it, so `toBeVisible` is
    // unsatisfiable here however right the document is. Counting it is the claim that can be true:
    // it is the same question step 3 asks with `toHaveCount(0)` when the Receipt is withheld.
    await expect(receiptDoc).toHaveCount(1);
    await expect(receiptDoc.getByTestId("payment-receipt-payment")).toHaveCount(2);
    await expect(receiptDoc).toContainText("Payment methods");
    await expect(receiptDoc.getByTestId("payment-receipt-tender").nth(0)).toContainText("Cash");
    await expect(receiptDoc.getByTestId("payment-receipt-tender").nth(0)).toContainText("$40.00");
    await expect(receiptDoc.getByTestId("payment-receipt-tender").nth(1)).toContainText("$61.60");
    // NOT A SERIES. "Payment 1 of 2" framed one settlement as two independent checkout events.
    await expect(receiptDoc).not.toContainText("Payment 1 of");
    await expect(receiptDoc).not.toContainText("Payment 2 of");
    // SETTLED, NOT PAID. The aggregate spans every tender type — client credit included, where no
    // money is collected at all — so calling it "paid" would claim a collection that may not have
    // happened. The INVOICE still shows `Paid` as its settlement status, and that stays correct.
    await expect(receiptDoc.getByTestId("payment-receipt-total-settled")).toContainText("$101.60");
    await expect(receiptDoc.getByTestId("payment-receipt-total-settled")).toContainText("Total settled");
    await expect(receiptDoc).not.toContainText("Total paid");
    // Nothing is owed, so nothing claims to be.
    await expect(receiptDoc.getByTestId("payment-receipt-balance")).toHaveCount(0);
    // NEVER A TICKET. The Ticket is the shop's work sheet, it has its own renderer and its own
    // print root, and the Receipt reaching it would hand a client an operational document.
    await expect(printRoot(page)).not.toContainText("Ticket");
    await expect(printRoot(page).getByTestId("ticket-document")).toHaveCount(0);
    // NOR THE INVOICE'S STATEMENT. A different document, not a retitled one.
    await expect(printRoot(page).locator(".receipt")).toHaveCount(0);
    for (const owed of ["Subtotal", "Discount", "Tax"]) {
      await expect(receiptDoc, owed).not.toContainText(owed);
    }
    // MANUAL CASH COMPONENTS, TRUTHFULLY. Method, amount, when each was taken, and each with its
    // own payment reference — and no processor and no processor payment id, because a cash payment
    // has neither and printing the labels empty would imply a card processor was involved.
    await expect(receiptDoc.getByTestId("payment-receipt-received")).toHaveCount(2);
    await expect(receiptDoc.getByTestId("payment-receipt-reference")).toHaveCount(2);
    await expect(receiptDoc).not.toContainText("Processor");
    for (const processorField of [
      "payment-receipt-provider",
      "payment-receipt-provider-payment-id"
    ]) {
      await expect(receiptDoc.getByTestId(processorField), processorField).toHaveCount(0);
    }
    // THE OPERATOR'S FREE TEXT IS NEVER ON THE CLIENT'S PAPER, whatever the payment shape. Unlike
    // the two lines above this is not "absent because this payment had no processor":
    // `external_reference` is unconstrained free text an operator types, so the Receipt does not
    // draw it at all. `tests/ui/payment-receipt.test.ts` holds that against every payment shape.
    await expect(receiptDoc.getByTestId("payment-receipt-external-reference")).toHaveCount(0);
    await expect(receiptDoc).not.toContainText("Processor reference");
    // The salon's identity heads this document too, through the same renderer, under its own id.
    await expect(receiptDoc.getByTestId("payment-receipt-salon"))
      .toContainText(`PW Smoke ${tenant.runId}`);
    await clearPrintRoots(page);

    // THE TICKET IS STILL A SEPARATE, OPERATIONAL DOCUMENT and is reached from this same settled
    // panel, carrying no money and no payment identity. `ticket-surface.spec.ts` holds the whole
    // of that contract; what matters here is that a settled bill did not turn the work sheet into
    // a financial one.
    await settled.getByTestId("checkout-ticket").click();
    const ticket = page.getByTestId("ticket-surface");
    await expect(ticket).toBeVisible();
    await expect(ticket.getByTestId("ticket-document")).not.toContainText("$");
    await expect(ticket.getByTestId("payment-receipt")).toHaveCount(0);
    await ticket.getByTestId("ticket-print").click();
    // Its own print root, its own markup: `.print-ticket` never carries a receipt or a figure.
    await expect(page.locator(".print-root.print-ticket")).toHaveCount(1);
    await expect(page.locator(".print-root.print-ticket")).not.toContainText("$");
    await expect(page.locator(".print-root.print-ticket .payment-receipt")).toHaveCount(0);
    await clearPrintRoots(page);
    await page.keyboard.press("Escape");
    await expect(ticket).toBeHidden();

    // ---- 5. VOIDED COMPONENTS --------------------------------------------------------------
    // A voided record settled nothing, and voiding one component of a completed settlement puts
    // its money back on the bill — so the settlement is no longer complete and the Receipt goes
    // with it. The INVOICE is unaffected throughout, which is the point of the two being
    // different documents: the bill is still printable at the exact moment the evidence is not.
    const answer = (dialog: Dialog) =>
      dialog.accept(dialog.type() === "prompt" ? "Keyed the wrong amount" : "");
    page.on("dialog", answer);
    await settled.getByRole("button", { name: "Void record" }).first().click();
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $40.00");
    await expect(settled.getByTestId("checkout-print-receipt")).toHaveCount(0);
    await expect(settled.getByTestId("checkout-print-invoice")).toBeVisible();

    // The second void has to happen on the document itself: a checkout with a balance shows the
    // form for collecting it rather than the payment records.
    await settled.locator("[data-surface-close]").click();
    await expect(checkoutSurface(page)).toBeHidden();
    await page.getByTestId("nav-customers").click();
    const client = page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" });
    await client.getByTestId("client-row-actions").click();
    await client.getByTestId("client-appointment-history").click();
    const modal = page.getByTestId("modal");
    // A PAID INVOICE OPENED FROM HISTORY IS AN INVOICE. This is the assertion the old client
    // failed: it read "Receipt" on the row and opened a page headed `Receipt #1042`.
    await expect(modal.getByRole("button", { name: "Receipt" })).toHaveCount(0);
    await modal.locator(`[data-testid="history-invoice"][data-invoice-id="${invoice.id}"]`).click();
    await expect(page.locator("#modal-title")).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    await expect(modal.locator(".receipt")).toContainText("Balance$40.00");

    await modal.getByRole("button", { name: "Void record" }).click();
    // The re-read comes back with nothing settled against the invoice, and the document is called
    // exactly what it was called before anybody paid: nothing about the title moved at all.
    await expect(page.locator("#modal-title")).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    page.off("dialog", answer);
    // The voided records are still ON the page — the corrections happened and are part of the
    // history — they are simply no longer presented as money currently paid.
    await expect(modal.locator(".receipt")).toContainText("voided");
    await expect(modal.locator(".receipt")).toContainText("Balance$101.60");
  });

test("a client's transaction history opens the Invoice, in every settlement state",
  async ({ page, request, tenant }) => {
    const unpaidVisit = await completeAppointment(request, tenant);
    const unpaid = await raiseInvoice(request, unpaidVisit.id);
    await login(page, tenant.ownerEmail);

    await page.getByTestId("nav-customers").click();
    const customer = page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" });
    await customer.getByTestId("client-row-actions").click();
    await customer.getByTestId("client-appointment-history").click();
    const modal = page.getByTestId("modal");

    // ONE ROW, AND IT DOES NOT SAY RECEIPT. The control opens an invoice, so it says Invoice.
    await expect(modal).toContainText(`Invoice ${unpaid.invoiceNumber}`);
    await expect(modal.getByRole("button", { name: "Receipt" })).toHaveCount(0);
    await modal.getByRole("button", { name: "Invoice" }).click();
    await expect(page.locator("#modal-title")).toHaveText(`Invoice #${unpaid.invoiceNumber}`);
    await expect(modal.locator(".receipt")).toContainText("No payment recorded.");
    await modal.getByRole("button", { name: "Cancel" }).click();

    // THE SAME CLIENT, A SETTLED VISIT, AND THE SAME CONTROL SAYS THE SAME WORD. The row used to
    // relabel itself "Receipt" the moment a payment landed, which is the paid-implies-Receipt rule
    // this client no longer has anywhere.
    const paidVisit = await completeAppointment(request, tenant);
    const paid = await raiseInvoice(request, paidVisit.id);
    const payment = await request.post(`/api/invoices/${paid.id}/payments`, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { amountMinor: paid.balanceMinor, expectedBalanceMinor: paid.balanceMinor, method: "cash" }
    });
    expect(payment.ok(), await payment.text()).toBeTruthy();

    await page.reload();
    await page.getByTestId("nav-customers").click();
    const again = page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" });
    await again.getByTestId("client-row-actions").click();
    await again.getByTestId("client-appointment-history").click();
    await expect(modal.getByRole("button", { name: "Receipt" })).toHaveCount(0);
    // Reached by invoice rather than by label, because BOTH rows now say the same word — which is
    // the change. The settled one opens under the same name the unpaid one did.
    await modal.locator(`[data-testid="history-invoice"][data-invoice-id="${paid.id}"]`).click();
    await expect(page.locator("#modal-title")).toHaveText(`Invoice #${paid.invoiceNumber}`);
    // Settlement changed the STATE and nothing else: the balance is gone and the payment record
    // is on the statement, under a title that never moved.
    await expect(modal.locator(".receipt")).toContainText("Balance$0.00");
    await expect(modal.locator(".receipt")).toContainText("recorded");

    // BOTH DOCUMENTS ARE REACHABLE HERE, WEEKS LATER. Everything needed to reproduce the Receipt
    // is persisted — the components, their references, their processor fields and their refunds —
    // so evidence of a completed settlement must not depend on still being in the browser session
    // that took the payment. This invoice was settled through the API and never through this page.
    await observePrinting(page);
    await expect(modal.getByTestId("invoice-print-invoice")).toBeVisible();
    await expect(modal.getByTestId("invoice-print-receipt")).toBeVisible();

    await modal.getByTestId("invoice-print-invoice").click();
    await expect(printRoot(page).locator("h1")).toHaveText(`Invoice #${paid.invoiceNumber}`);
    await clearPrintRoots(page);

    await modal.getByTestId("invoice-print-receipt").click();
    await expect(printRoot(page).locator("h1")).toHaveText(`Receipt #${paid.invoiceNumber}`);
    await expect(printRoot(page).getByTestId("payment-receipt-total-settled"))
      .toContainText("Total settled");
    await expect(printRoot(page).getByTestId("ticket-document")).toHaveCount(0);
    // The dialog underneath did not change document while its own control printed a second one.
    await expect(page.locator("#modal-title")).toHaveText(`Invoice #${paid.invoiceNumber}`);
    await clearPrintRoots(page);
  });

test("an unsettled invoice from transaction history prints the bill and offers no Receipt",
  async ({ page, request, tenant }) => {
    // The other half of the rule, on the surface that reaches a visit long after it happened: the
    // Receipt is ABSENT rather than disabled on an invoice that is still owing, which is the same
    // deliberate answer the Check Out footer gives. A control that is present but refuses would
    // invite an operator to hunt for the reason.
    const visit = await completeAppointment(request, tenant);
    const unsettled = await raiseInvoice(request, visit.id);
    const part = await request.post(`/api/invoices/${unsettled.id}/payments`, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { amountMinor: 4000, expectedBalanceMinor: unsettled.balanceMinor, method: "cash" }
    });
    expect(part.ok(), await part.text()).toBeTruthy();

    await login(page, tenant.ownerEmail);
    await observePrinting(page);
    await page.getByTestId("nav-customers").click();
    const customer = page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" });
    await customer.getByTestId("client-row-actions").click();
    await customer.getByTestId("client-appointment-history").click();
    const modal = page.getByTestId("modal");
    await modal.locator(`[data-testid="history-invoice"][data-invoice-id="${unsettled.id}"]`).click();

    await expect(page.locator("#modal-title")).toHaveText(`Invoice #${unsettled.invoiceNumber}`);
    await expect(modal.getByTestId("invoice-print-invoice")).toBeVisible();
    await expect(modal.getByTestId("invoice-print-receipt")).toHaveCount(0);

    await modal.getByTestId("invoice-print-invoice").click();
    await expect(printRoot(page).locator("h1")).toHaveText(`Invoice #${unsettled.invoiceNumber}`);
    await expect(printRoot(page).locator(".receipt")).toContainText("Balance$61.60");
    await expect(printRoot(page).getByTestId("payment-receipt")).toHaveCount(0);
    await clearPrintRoots(page);
  });

test("a scheduled appointment has a Ticket and no financial document at all",
  async ({ page, request, tenant }) => {
    // The first state in the contract: no invoice, so nothing financial exists to name. Exposing a
    // Ticket must not expose an Invoice or a Receipt, and the surface that offers the sheet offers
    // nothing else.
    const appointment = await createAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    await page.getByTestId("nav-calendar").click();
    await page.waitForLoadState("networkidle");
    await page.locator(`[data-appointment-id="${appointment.id}"]`).first().click();

    const surface = page.getByTestId("appointment-detail-surface");
    await expect(surface).toBeVisible();
    await expect(page.getByTestId("appointment-billing")).toHaveText("Not invoiced");
    await expect(page.getByTestId("appointment-ticket")).toBeVisible();
    await expect(page.getByTestId("appointment-ticket-print")).toBeVisible();
    for (const financial of [
      "checkout-print-receipt", "checkout-print-invoice", "receipt", "payment-receipt"
    ]) {
      await expect(page.getByTestId(financial), financial).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: /receipt/iu })).toHaveCount(0);
  });
