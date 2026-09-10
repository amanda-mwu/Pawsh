import { test, expect, login, completeAppointment } from "./fixtures/tenant.js";
import { closeInvoice, invoiceStatement, invoiceSurface } from "./helpers/invoice.js";
import { chooseMethod, checkoutSurface } from "./helpers/checkout.js";
import { voidRecord } from "./helpers/void-payment.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * VOIDING A PAYMENT PUTS THE MONEY BACK ON THE BILL, AND THE VISIT MUST OFFER A WAY TO TAKE IT.
 *
 * The defect this spec exists for, reproduced by the owner exactly as it is walked below: void the
 * payment on a settled invoice, and the invoice returns to `Open` with $79.01 owing. The
 * appointment chip said so correctly — `Open · $79.01 due` — and the footer under it still showed
 * `Invoice` with no Take Payment anywhere. The operator was stranded on the one screen that had
 * just told them money was due, with no control that could collect it.
 *
 * The cause was that the footer asked whether an invoice RECORD existed rather than what state
 * that invoice was in. Voiding a payment does not remove the invoice, so the test never changed.
 *
 * WHAT THIS SPEC IS FOR, AND WHY IT IS A BROWSER SPEC. The action rules themselves are decided by
 * `derive` and are held deterministically in `tests/ui/appointment-invoice-route.test.ts`. Two
 * things cannot be asserted there and are the reason this walk exists:
 *
 *   THE STATE ACTUALLY TRANSITIONS. `Open`, `$79.01`, `partially_paid`, `Paid` are the SERVER's
 *       answers to a real void and a real tender, not fixtures a test wrote to agree with itself.
 *   NO SECOND INVOICE IS RAISED. Every `POST /api/appointments/:id/checkout` this page sends is
 *       recorded, and the assertion is that it sends none — the direct evidence that Take Payment
 *       on an invoiced visit collects against the bill that already exists. The same property is
 *       asserted from the calendar's door by "@regression-checkout an existing invoice is
 *       collected against, not raised again"; this asserts it from the APPOINTMENT FOOTER, which
 *       is the door that did not exist before and the only one an operator has after a void.
 *
 * IT ALSO WALKS THE REFRESH. The owner found this IMMEDIATELY after voiding, without closing and
 * reopening anything, so the void is taken here from inside the Invoice workspace over the visit
 * and the footer underneath is asserted after the workspace closes — the path the surface's own
 * reload runs on, against the server's answer rather than a calendar snapshot.
 *
 * NOT IN SCOPE HERE and deliberately untouched: refund semantics, the settlement model, and the
 * void history itself. A voided record stays on the statement forever; that is asserted below
 * because the fix was not allowed to lose it, not because this spec owns it.
 *
 * The figures above are the owner's, off her own bill. The figures BELOW are the tenant fixture's
 * — an $85.00 groom, $5.00 off, $6.60 of tax and a $15.00 tip, so $101.60 — and every one of them
 * is read off what the server returned rather than written into the spec, because what this walk
 * is about is that the transitions happen at all.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");
const takePayment = (page: Page): Locator => detail(page).getByTestId("appointment-take-payment");
const invoiceButton = (page: Page): Locator => detail(page).getByTestId("appointment-invoice");

/** Raises the invoice through the API, so its figures are fixed before the browser opens it. */
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

/** What the server says about the invoice, which is the only authority on any of this. */
async function invoiceState(api: APIRequestContext, invoiceId: string): Promise<{
  status: string; balanceMinor: number;
}> {
  const response = await api.get(`/api/invoices/${invoiceId}/receipt`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as {
    invoice: { status: string; balanceMinor: number };
  };
  // The two columns the appointment projection carries and the footer decides from, and only
  // those: the rest of the invoice row is not what any assertion here is about.
  return { status: payload.invoice.status, balanceMinor: payload.invoice.balanceMinor };
}

/** Opens the appointment detail surface from the calendar, the way an operator reaches it. */
async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

/** Money in dollars, written the way the statement writes it. */
const dollars = (minor: number): string => `$${(minor / 100).toFixed(2)}`;

test("a voided payment reopens the invoice and the appointment offers Take Payment for it",
  async ({ page, request, tenant }) => {
    const appointment = await completeAppointment(request, tenant);
    const invoice = await raiseInvoice(request, appointment.id);
    await settleInvoice(request, invoice.id, invoice.balanceMinor);
    const due = dollars(invoice.balanceMinor);

    await login(page, tenant.ownerEmail);

    // EVERY attempt to raise an invoice from this page, recorded from the first navigation. The
    // assertion at the end is that there were none: the repayment collected against the invoice
    // that already existed.
    const checkoutPosts: string[] = [];
    page.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST"
        && /\/api\/appointments\/[^/]+\/checkout$/u.test(new URL(outgoing.url()).pathname)
      ) checkoutPosts.push(outgoing.url());
    });

    // ── 1. SETTLED: Paid, Invoice, no Take Payment ─────────────────────────────────────────────
    await openDetail(page, appointment.id);
    await expect(page.getByTestId("appointment-billing")).toHaveText("Paid");
    await expect(takePayment(page)).toHaveCount(0);
    await expect(invoiceButton(page)).toBeVisible();
    await expect(invoiceButton(page)).toHaveClass(/primary/u);

    // ── 2. THE VOID, taken from inside the Invoice over the visit ──────────────────────────────
    await invoiceButton(page).click();
    await expect(invoiceSurface(page)).toBeVisible();
    await expect(invoiceStatement(page)).toContainText("Balance$0.00");
    // The Receipt exists while the settlement is complete. It is about to stop existing, which is
    // the gate this spec checks rather than restates.
    await expect(invoiceSurface(page).getByTestId("invoice-print-receipt")).toBeVisible();

    const stated = await voidRecord(
      page,
      invoiceSurface(page).getByRole("button", { name: "Void record" }),
      "Cash was never handed over"
    );
    expect(stated).toContain("does not refund external funds");

    // The server's answer, and it is the one every assertion below is really about.
    expect(await invoiceState(request, invoice.id))
      .toEqual({ status: "open", balanceMinor: invoice.balanceMinor });

    // The workspace redrew in place - it is the receipt host while it is open - so the statement
    // under the operator already says what is owed.
    await expect(invoiceStatement(page)).toContainText(`Balance${due}`);
    // AND THE VOIDED RECORD IS STILL THERE. History is not deleted by being corrected.
    await expect(invoiceStatement(page)).toContainText(`Cash · voided${due}`);
    // The Receipt is unavailable while the invoice is open: it evidences a COMPLETED settlement,
    // and there is not one any more. The Invoice is still printable, as it is in every state.
    await expect(invoiceSurface(page).getByTestId("invoice-print-receipt")).toHaveCount(0);
    await expect(invoiceSurface(page).getByTestId("invoice-print-invoice")).toBeVisible();

    // ── 3. BACK ON THE VISIT, WITHOUT REOPENING ANYTHING ───────────────────────────────────────
    await closeInvoice(page);
    await expect(detail(page)).toBeVisible();
    // The chip was always right. The footer is what was wrong.
    await expect(page.getByTestId("appointment-billing")).toHaveText(`Open · ${due} due`);
    // THE CONTROL THAT DID NOT EXIST.
    await expect(takePayment(page)).toBeVisible();
    await expect(takePayment(page)).toHaveClass(/primary/u);
    // And the bill is still reachable, in the slot it gave up rather than out of the footer: an
    // unsettled invoice is still a document, and it holds the void that was just recorded.
    await expect(invoiceButton(page)).toBeVisible();
    await expect(invoiceButton(page)).toHaveClass(/secondary/u);
    // Exactly one primary action, so the two cannot both claim the slot.
    await expect(detail(page).locator("footer .primary")).toHaveCount(1);

    // ── 4. COLLECTING AGAINST THE EXISTING INVOICE ─────────────────────────────────────────────
    await takePayment(page).click();
    await expect(checkoutSurface(page)).toBeVisible();
    // Check Out says whose bill this is: the invoice is raised, and only the payment is open.
    await expect(page.getByTestId("checkout-frozen")).toContainText("already raised");
    await expect(page.getByTestId("checkout-frozen"))
      .toContainText(`Invoice ${invoice.invoiceNumber}`);
    // Nothing that would change the invoice is offered - no discount, no coupon, no tip.
    await expect(page.locator("[data-checkout-disclosure]")).toHaveCount(0);
    // And it opens on the CURRENT outstanding balance, which is what the void put back.
    await expect(page.getByTestId("checkout-balance")).toContainText(`Balance ${due}`);

    await chooseMethod(page, "Cash");
    await page.getByTestId("checkout-submit").click();

    // ── 5. SETTLED AGAIN ───────────────────────────────────────────────────────────────────────
    await expect(checkoutSurface(page).getByTestId("receipt")).toContainText("Balance$0.00");
    // THE PROOF, and it is the absence of a request rather than a claim about one: not one
    // `POST /api/appointments/:id/checkout` was sent from the moment this page loaded.
    expect(checkoutPosts, "an existing invoice must not be raised a second time").toEqual([]);
    // The server agrees, on the SAME invoice id the page opened with. A second invoice would have
    // left this one open.
    expect(await invoiceState(request, invoice.id)).toEqual({ status: "paid", balanceMinor: 0 });
    // One invoice on this appointment, counted where a duplicate would show.
    const invoices = await request.get(`/api/customers/${tenant.customerId}/history`);
    expect(invoices.ok(), await invoices.text()).toBeTruthy();
    const history = (await invoices.json()) as { invoices: { id: string }[] };
    expect(history.invoices.map((row) => row.id)).toEqual([invoice.id]);

    // The voided record is still on the settled statement, beside the payment that replaced it.
    await expect(checkoutSurface(page).getByTestId("receipt")).toContainText(`Cash · voided${due}`);
    await expect(checkoutSurface(page).getByTestId("receipt")).toContainText(`Cash · recorded${due}`);

    // ── 6. AND THE FOOTER SWAPS BACK ───────────────────────────────────────────────────────────
    await page.getByTestId("checkout-done").click();
    await expect(detail(page)).toBeVisible();
    await expect(page.getByTestId("appointment-billing")).toHaveText("Paid");
    await expect(takePayment(page)).toHaveCount(0);
    await expect(invoiceButton(page)).toHaveClass(/primary/u);
    // The Receipt is available again, from the door that leads to it.
    await invoiceButton(page).click();
    await expect(invoiceSurface(page).getByTestId("invoice-print-receipt")).toBeVisible();
    await expect(invoiceStatement(page)).toContainText(`Cash · voided${due}`);
  });

test("the reopened statement still reads as grouped sections in every host it has",
  async ({ page, request, tenant }) => {
    // DEFECT 1 AND DEFECT 2 MEET HERE. The money statement is shared by three hosts, and a bill
    // that has been voided back open is the state the owner was reading when she reported it as
    // "too flat". This walks the same statement in two of its hosts after the void and asserts the
    // hierarchy it now has: the groups, the one emphasised total, and no generic `Subtotal`.
    //
    // That all THREE hosts agree cell for cell is `tests/e2e/ticket-surface.spec.ts`.
    const appointment = await completeAppointment(request, tenant);
    const invoice = await raiseInvoice(request, appointment.id);
    await settleInvoice(request, invoice.id, invoice.balanceMinor);
    const due = dollars(invoice.balanceMinor);

    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);
    await invoiceButton(page).click();
    await voidRecord(
      page,
      invoiceSurface(page).getByRole("button", { name: "Void record" }),
      "Cash was never handed over"
    );

    const statement = invoiceStatement(page);
    // The groups, by their headings, in order.
    await expect(statement.locator("h4.receipt-group")).toHaveText([
      "Services", "Discounts", "Payment records"
    ]);
    // ONE emphasised final total, named for what it is.
    await expect(statement.locator(".receipt-total")).toHaveCount(1);
    await expect(statement.getByTestId("receipt-invoice-total")).toContainText("Invoice total");
    // The subtotal is named for what it is a subtotal OF, and the generic label is gone.
    await expect(statement.getByTestId("receipt-service-subtotal"))
      .toContainText("Service subtotal$85.00");
    await expect(statement).not.toContainText("Subtotal$");
    // What is owed now, separate from what the visit came to, and not competing with it.
    await expect(statement.getByTestId("receipt-balance")).toContainText(`Balance${due}`);
    await expect(statement.getByTestId("receipt-balance")).not.toHaveClass(/receipt-total/u);
    // The discount kept its name and its amount through the restructure.
    await expect(statement.getByTestId("receipt-discount")).toContainText("-$5.00");

    // Host two: the same statement on paper, drawn by the same renderer into the print root. The
    // hierarchy is markup rather than a screen rule, so it survives the crossing.
    await closeInvoice(page);
    await takePayment(page).click();
    await expect(checkoutSurface(page)).toBeVisible();
    await chooseMethod(page, "Cash");
    await page.getByTestId("checkout-submit").click();
    const settled = checkoutSurface(page).getByTestId("receipt");
    await expect(settled.locator("h4.receipt-group")).toHaveText([
      "Services", "Discounts", "Payment records"
    ]);
    await expect(settled.locator(".receipt-total")).toHaveCount(1);
    await expect(settled.getByTestId("receipt-invoice-total")).toContainText("Invoice total");
    await expect(settled.getByTestId("receipt-balance")).toContainText("Balance$0.00");
  });
