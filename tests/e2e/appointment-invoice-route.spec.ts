import { test, expect, login, completeAppointment } from "./fixtures/tenant.js";
import { observePrinting, clearPrintRoots, printFromPreview } from "./helpers/print.js";
import { closeInvoice, invoiceStatement, invoiceSurface, invoiceTitle } from "./helpers/invoice.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * A PAID APPOINTMENT REACHES ITS OWN INVOICE, FROM THE APPOINTMENT.
 *
 * The defect this spec exists for, on the natural operator path: the moment a visit was invoiced,
 * Take Payment left the appointment footer — correctly, because the server refuses a second
 * checkout — and NOTHING REPLACED IT. A settled visit whose own header read "Paid" therefore had
 * no route at all to the bill that said so. The only way in was Client → Transaction History: a
 * detour through the client to reach a document that belongs to this appointment. Meanwhile the
 * Ticket, which carries no money at all, stayed one button away in every state.
 *
 * The route added is a DOOR, not a document. It opens the same Invoice WORKSPACE that a client's
 * transaction history and the terminal-capture screen open, off the same
 * `GET /api/invoices/:id/receipt` payload, so there is one Invoice with one title and one pair of
 * print controls however the operator arrived at it. Reached from here it is a LEVEL OVER THE
 * VISIT: the appointment is still underneath, and closing the Invoice pops back onto it.
 *
 * What that workspace itself owes — Print Invoice in every settlement state, Print Receipt only
 * once the settlement completed, and BOTH once it has — is held by
 * `tests/e2e/invoice-receipt-identity.spec.ts`, and what it SAYS is held deterministically by
 * `tests/ui/invoice-workspace.test.ts`. This spec walks the door and checks the same two
 * documents come out of it.
 *
 * The permission half is deterministic and lives in `tests/ui/appointment-invoice-route.test.ts`:
 * the control is gated on `payments.view` rather than `checkout.perform`, it is DISABLED rather
 * than absent for an actor who lacks it — the billing chip beside it has already said the invoice
 * exists, so drawing nothing would contradict it — and the handler refuses on its own rather than
 * trusting the `disabled` attribute a console can remove.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");
const ticket = (page: Page): Locator => page.getByTestId("ticket-surface");
const printRoot = (page: Page): Locator => page.locator(".print-root");

/** Raises the invoice through the API, so its number and figures are fixed before the browser. */
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

/** Settles it in full, so the visit the browser opens is genuinely a settled one. */
async function settleInvoice(
  api: APIRequestContext,
  invoiceId: string,
  balanceMinor: number
): Promise<void> {
  const response = await api.post(`/api/invoices/${invoiceId}/payments`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { amountMinor: balanceMinor, expectedBalanceMinor: balanceMinor, method: "cash" }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** Opens the appointment detail surface from the calendar, the way an operator reaches it. */
async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

test("a settled appointment opens its own Invoice from the appointment footer",
  async ({ page, request, tenant }) => {
    await observePrinting(page);
    const appointment = await completeAppointment(request, tenant);
    const invoice = await raiseInvoice(request, appointment.id);
    await settleInvoice(request, invoice.id, invoice.balanceMinor);
    await login(page, tenant.ownerEmail);

    // ---- The visit, opened from the calendar -----------------------------------------------
    await openDetail(page, appointment.id);
    // The chip that tells the operator there is a bill. It was already correct before this fix,
    // and that was the whole problem: the surface stated a settlement it could not show.
    await expect(page.getByTestId("appointment-billing")).toHaveText("Paid");
    await expect(page.getByTestId("appointment-status")).toHaveText("completed");

    // ---- The footer -------------------------------------------------------------------------
    // Take Payment is gone, and it should be: the server refuses a second checkout on an invoiced
    // visit, so offering it would be offering a refusal.
    await expect(detail(page).getByTestId("appointment-take-payment")).toHaveCount(0);
    // In the slot it gave up, the bill. This is the control that did not exist.
    const invoiceControl = detail(page).getByTestId("appointment-invoice");
    await expect(invoiceControl).toBeVisible();
    await expect(invoiceControl).toBeEnabled();
    await expect(invoiceControl).toHaveText("Invoice");
    // The Ticket is still here, still one button away, and no longer the primary control - the
    // operator opening a settled visit came for the money document.
    await expect(detail(page).getByTestId("appointment-ticket")).toBeVisible();
    await expect(detail(page).getByTestId("appointment-ticket")).toHaveClass(/secondary/u);
    await expect(invoiceControl).toHaveClass(/primary/u);

    // ---- The Invoice, in the one workspace that owns it ---------------------------------------
    await invoiceControl.click();
    const document_ = invoiceSurface(page);
    await expect(document_).toBeVisible();
    // SAME TITLE AS EVERY OTHER DOOR. Settlement moved a balance and added a payment record;
    // neither is a change of document, and this surface does not get to rename it.
    await expect(invoiceTitle(page)).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    await expect(invoiceStatement(page)).toContainText("Balance$0.00");
    // AND IT IS NOT THE FORM DIALOG ANY MORE. The Invoice used to be drawn into `#modal`, which
    // gave a financial document a two-column field grid and a green Save that saved nothing.
    await expect(page.getByTestId("modal")).toBeHidden();
    // The whole viewport, used. A settled bill on a desktop had a 650px column of simulated
    // paper and two controls below the bottom of it.
    const width = await document_.locator(".surface-shell").evaluate((node) => node.clientWidth);
    const viewport = page.viewportSize()!.width;
    expect(width).toBeGreaterThan(viewport * 0.9);
    // Two columns on a desktop: the statement on the left, where the invoice stands on the right.
    await expect(document_.getByTestId("invoice-statement")).toBeVisible();
    await expect(document_.getByTestId("invoice-summary")).toBeVisible();
    const statement = await document_.getByTestId("invoice-statement").boundingBox();
    const summary = await document_.getByTestId("invoice-summary").boundingBox();
    expect(summary!.x).toBeGreaterThan(statement!.x);

    // ---- BOTH documents, neither replacing the other -----------------------------------------
    await expect(document_.getByTestId("invoice-print-invoice")).toBeVisible();
    await expect(document_.getByTestId("invoice-print-receipt")).toBeVisible();
    // AND THE ACTIONS ARE REACHABLE WITHOUT SCROLLING PAST THE DOCUMENT. The footer is the
    // shell's own row, outside the body's scroller, so it is on screen the moment the Invoice is.
    await expect(document_.getByTestId("invoice-print-invoice")).toBeInViewport();

    await document_.getByTestId("invoice-print-invoice").click();
    await printFromPreview(page);
    await expect(printRoot(page).locator("h1")).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    await expect(printRoot(page).locator(".receipt")).toContainText("Balance$0.00");
    await clearPrintRoots(page);

    await document_.getByTestId("invoice-print-receipt").click();
    await printFromPreview(page);
    await expect(printRoot(page).locator("h1")).toHaveText(`Receipt #${invoice.invoiceNumber}`);
    const receiptDoc = printRoot(page).getByTestId("payment-receipt");
    // PRESENT, not "visible". `.print-root{display:none}` keeps every print document off the
    // screen and `@media print` is the only thing that reveals it.
    await expect(receiptDoc).toHaveCount(1);
    await expect(receiptDoc).toContainText("Total settled");
    // THE RECEIPT IS NOT THE TICKET. The Ticket is the shop's work sheet and has its own renderer
    // and its own print root; a financial control reaching it would hand a client an operational
    // document about the pet.
    await expect(printRoot(page).getByTestId("ticket-document")).toHaveCount(0);
    await expect(printRoot(page)).not.toContainText("Ticket");
    await clearPrintRoots(page);

    // ---- Closing it puts the operator back on the visit they came from -----------------------
    await closeInvoice(page);
    await expect(detail(page)).toBeVisible();
    await expect(page.getByTestId("appointment-billing")).toHaveText("Paid");

    // ---- And the Ticket is still its own separate document -----------------------------------
    await detail(page).getByTestId("appointment-ticket").click();
    await expect(ticket(page)).toBeVisible();
    await ticket(page).getByTestId("ticket-print").click();
    await printFromPreview(page);
    await expect(printRoot(page).getByTestId("ticket-document")).toHaveCount(1);
    // A work sheet, carrying no money at all: no invoice number, no settlement, no total.
    await expect(printRoot(page).getByTestId("payment-receipt")).toHaveCount(0);
    await expect(printRoot(page).locator(".receipt")).toHaveCount(0);
    await expect(printRoot(page)).not.toContainText(`Invoice #${invoice.invoiceNumber}`);
    await expect(printRoot(page)).not.toContainText("Total settled");
  });
