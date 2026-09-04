import { test, expect, login, completeAppointment, createAppointment } from "./fixtures/tenant.js";
import { openCheckout, chooseMethod, setPayAmount, checkoutSurface } from "./helpers/checkout.js";
import { observePrinting, clearPrintRoots } from "./helpers/print.js";
import type { APIRequestContext, Dialog, Page } from "@playwright/test";

/**
 * A RECEIPT REQUIRES A RECORDED PAYMENT.
 *
 * Four documents, and only one of them is evidence:
 *
 *   Ticket   the CRM document for the visit — who, which pet, which services.
 *   Invoice  a financial obligation. It exists the moment the visit is billed and it can owe
 *            money for as long as nobody pays it.
 *   Payment  a settlement against an invoice.
 *   Receipt  evidence of a recorded payment.
 *
 * The printable financial page was titled `Receipt #<invoiceNumber>` and its button offered from
 * the moment an invoice existed, so a client could be handed "Receipt #1042 / Balance $135.60 / No
 * payment recorded". That artifact is an Invoice. THE SERVER PROJECTION WAS ALWAYS CORRECT — it
 * carries the payment rows and the balance — and this is the client's title, button and gating
 * corrected against it.
 *
 * The money statement itself stays SHARED: `receiptBodyMarkup` renders the invoice's figures for
 * both documents, and `tests/e2e/ticket-surface.spec.ts` holds the single-money-statement
 * invariant. Shared financial authority is required; shared document identity is not, and the
 * ladder below walks every state the contract names.
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

test("the financial document is an Invoice until a payment is recorded, and a Receipt after",
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
    // what it must not do is call itself evidence of a payment nobody made.
    await expect(owing.getByTestId("checkout-print-receipt")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /send receipt/iu })).toHaveCount(0);
    // The printable document still exists — an operator hands a client the bill — and it says
    // exactly what it is.
    await expect(owing.getByTestId("checkout-print-invoice")).toBeVisible();
    await owing.getByTestId("checkout-print-invoice").click();
    await expect(printRoot(page).locator("h1")).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    await expect(printRoot(page)).toContainText("No payment recorded.");
    await clearPrintRoots(page);

    // ---- 3. PARTIALLY PAID ----------------------------------------------------------------
    // A payment is recorded, so a Receipt may exist — even though the invoice still owes money.
    await chooseMethod(page, "Cash");
    await setPayAmount(page, "40.00");
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $61.60");
    const partial = checkoutSurface(page);
    await expect(partial.getByTestId("checkout-print-invoice")).toHaveCount(0);
    await expect(partial.getByTestId("checkout-print-receipt")).toBeVisible();
    await partial.getByTestId("checkout-print-receipt").click();
    await expect(printRoot(page).locator("h1")).toHaveText(`Receipt #${invoice.invoiceNumber}`);
    // Accurate, not flattering: the receipt evidences what was paid and still states what is owed.
    await expect(printRoot(page).locator(".receipt")).toContainText("Balance$61.60");
    await clearPrintRoots(page);

    // ---- 4. FULLY PAID ---------------------------------------------------------------------
    await chooseMethod(page, "Cash");
    await setPayAmount(page, "61.60");
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $0.00");
    const settled = checkoutSurface(page);
    await expect(settled.getByTestId("checkout-done")).toBeVisible();
    await expect(settled.getByTestId("checkout-print-receipt")).toBeVisible();
    await expect(settled.getByTestId("checkout-print-invoice")).toHaveCount(0);

    // ---- 5. VOIDED PAYMENTS ----------------------------------------------------------------
    // A voided record settled nothing. One void of two leaves a settlement standing, so the
    // document is still a Receipt; voiding the last one puts the obligation back whole and the
    // document has to give the name back with it.
    const answer = (dialog: Dialog) =>
      dialog.accept(dialog.type() === "prompt" ? "Keyed the wrong amount" : "");
    page.on("dialog", answer);
    await settled.getByRole("button", { name: "Void record" }).first().click();
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $40.00");
    // STILL A RECEIPT. Money was taken and has not been given back, and the invoice owing again is
    // a fact about the balance rather than about whether anybody ever paid.
    await expect(settled.getByTestId("checkout-print-receipt")).toBeVisible();
    await expect(settled.getByTestId("checkout-print-invoice")).toHaveCount(0);

    // The second void has to happen on the document itself: a checkout with a balance shows the
    // form for collecting it rather than the payment records.
    await settled.locator("[data-surface-close]").click();
    await expect(checkoutSurface(page)).toBeHidden();
    await page.getByTestId("nav-customers").click();
    const client = page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" });
    await client.getByTestId("client-row-actions").click();
    await client.getByTestId("client-appointment-history").click();
    const modal = page.getByTestId("modal");
    await modal.getByRole("button", { name: "Receipt" }).click();
    await expect(page.locator("#modal-title")).toHaveText(`Receipt #${invoice.invoiceNumber}`);

    await modal.getByRole("button", { name: "Void record" }).click();
    // The re-read comes back with nothing settled against the invoice, and the document renames
    // itself on the way back in.
    await expect(page.locator("#modal-title")).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    page.off("dialog", answer);
    // The voided records are still ON the page — the corrections happened and are part of the
    // history — they are simply no longer presented as money currently paid.
    await expect(modal.locator(".receipt")).toContainText("voided");
    await expect(modal.locator(".receipt")).toContainText("Balance$101.60");
  });

test("a client's transaction history names each document by what has been paid against it",
  async ({ page, request, tenant }) => {
    const unpaidVisit = await completeAppointment(request, tenant);
    const unpaid = await raiseInvoice(request, unpaidVisit.id);
    await login(page, tenant.ownerEmail);

    await page.getByTestId("nav-customers").click();
    const customer = page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" });
    await customer.getByTestId("client-row-actions").click();
    await customer.getByTestId("client-appointment-history").click();
    const modal = page.getByTestId("modal");

    // ONE ROW, AND IT DOES NOT SAY RECEIPT. The row's own status says Open; the control beside it
    // used to say Receipt regardless, and opening it produced a page headed "Receipt #…".
    await expect(modal).toContainText(`Invoice ${unpaid.invoiceNumber}`);
    await expect(modal.getByRole("button", { name: "Receipt" })).toHaveCount(0);
    await modal.getByRole("button", { name: "Invoice" }).click();
    await expect(page.locator("#modal-title")).toHaveText(`Invoice #${unpaid.invoiceNumber}`);
    await expect(modal.locator(".receipt")).toContainText("No payment recorded.");
    await modal.getByRole("button", { name: "Cancel" }).click();

    // The same client, a settled visit, and the same control now names the document correctly.
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
    await expect(modal.getByRole("button", { name: "Receipt" })).toHaveCount(1);
    await modal.getByRole("button", { name: "Receipt" }).click();
    await expect(page.locator("#modal-title")).toHaveText(`Receipt #${paid.invoiceNumber}`);
  });

test("a scheduled appointment has a Ticket and no financial document at all",
  async ({ page, request, tenant }) => {
    // The first state in the contract: no invoice, so nothing financial exists to name. Exposing a
    // Ticket must not expose a Receipt, and the surface that offers the sheet offers nothing else.
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
    for (const financial of ["checkout-print-receipt", "checkout-print-invoice", "receipt"]) {
      await expect(page.getByTestId(financial), financial).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: /receipt/iu })).toHaveCount(0);
  });
