import { test, expect, login, completeAppointment, createMember } from "./fixtures/tenant.js";
import { openCheckout, openAdjustment, chooseMethod, checkoutSurface } from "./helpers/checkout.js";
import type { APIRequestContext } from "@playwright/test";

/**
 * Check Out — level 2 of the appointment stack.
 *
 * What is new here is the amount. The server has always accepted a payment smaller than the
 * balance — it decrements, marks the invoice `partially_paid`, and a second one closes it — and
 * has always refused a larger one at the `+1` boundary. The old dialog offered neither: it sent
 * `amountMinor: invoice.balanceMinor` and nothing else. These specs are about the control that
 * finally exposes what the ledger could already do, and about the two rules around it: an
 * over-payment is only ever a tip, and a tip can only be raised before the invoice exists.
 */

async function invoiceFor(request: APIRequestContext, appointmentId: string) {
  const response = await request.get(`/api/appointments/${appointmentId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const { invoiceId } = (await response.json()) as { invoiceId: string | null };
  expect(invoiceId).toBeTruthy();
  const receipt = await request.get(`/api/invoices/${invoiceId}/receipt`);
  return (await receipt.json()) as {
    invoice: { balanceMinor: number; tipMinor: number; totalMinor: number; status: string };
    payments: Array<{ amountMinor: number }>;
  };
}

test("the bill is priced before the invoice exists, and the amount defaults to it", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await completeAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await openCheckout(page, appointment.id);

  // Subtotal, tax and total are the browser's own mirror of calculateInvoice — one rounding step,
  // no second opinion about anything else — so the operator can see what they are about to charge
  // before there is an invoice to read it off.
  await expect(page.getByTestId("checkout-subtotal")).toHaveText("$85.00");
  await expect(page.getByTestId("checkout-tax")).toHaveText("$7.01");
  await expect(page.getByTestId("checkout-total")).toHaveText("$92.01");
  await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $92.01");
  await expect(page.getByTestId("field-pay")).toHaveValue("92.01");

  // A tip moves all three, because it is part of what the customer is being asked for.
  await (await openAdjustment(page, "tip")).getByTestId("field-tip").fill("5");
  await expect(page.getByTestId("checkout-total")).toHaveText("$97.01");
  await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $97.01");
});

test("a part payment is taken for what was typed, and the balance says what is left", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await completeAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await openCheckout(page, appointment.id);

  await page.getByTestId("field-pay").fill("40.00");
  // Said while the operator is still deciding, not discovered on the receipt.
  await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $92.01 · $52.01 will remain");
  await chooseMethod(page, "Cash");
  await page.getByTestId("checkout-submit").click();

  // Not settled: there is still money owed, so the screen is still collecting it.
  await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $52.01");
  await expect(page.getByTestId("checkout-submit")).toBeVisible();
  await expect(page.getByTestId("checkout-frozen")).toContainText("already raised");
  const partial = await invoiceFor(request, appointment.id);
  expect(partial.invoice.status).toBe("partially_paid");
  expect(partial.invoice.balanceMinor).toBe(5201);

  // The second part closes it, and only then does the screen become the receipt.
  await expect(page.getByTestId("field-pay")).toHaveValue("52.01");
  await chooseMethod(page, "Cash");
  await page.getByTestId("checkout-submit").click();
  await expect(checkoutSurface(page).getByTestId("receipt")).toContainText("Balance$0.00");
  await expect(page.getByTestId("checkout-done")).toBeVisible();
  const closed = await invoiceFor(request, appointment.id);
  expect(closed.invoice.status).toBe("paid");
  expect(closed.payments.map((payment) => payment.amountMinor)).toEqual([4000, 5201]);
});

test("an over-payment is only ever a tip, and only before the invoice exists", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await completeAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await openCheckout(page, appointment.id);

  // Hidden until it has something to say. A checkbox that is inert on almost every visit is
  // furniture, and furniture is what an operator stops reading.
  const remainder = page.getByTestId("checkout-remainder");
  await expect(remainder).toBeHidden();

  await page.getByTestId("field-pay").fill("100.00");
  await expect(remainder).toBeVisible();
  await expect(remainder).toContainText("Apply $7.99 remainder to tip");

  // Left unticked it is an over-payment, which the server refuses at the +1 boundary — so it is
  // refused here instead, before an invoice is raised that the payment then cannot settle.
  await chooseMethod(page, "Cash");
  await page.getByTestId("checkout-submit").click();
  await expect(page.locator("#checkout-error")).toContainText("$7.99 more than the balance");
  await expect(page.getByTestId("checkout-surface")).toBeVisible();

  // Ticked, the remainder folds into the tip AT INVOICE CREATION. It cannot be raised afterwards:
  // a Terminal checkout refuses to start against a non-zero tip, and the reconciler raises the tip
  // under `tip_minor = 0`, so a post-invoice tip either blocks the terminal or collides with it.
  await remainder.locator("input").check();
  await page.getByTestId("checkout-submit").click();
  await expect(checkoutSurface(page).getByTestId("receipt")).toContainText("Balance$0.00");

  const settled = await invoiceFor(request, appointment.id);
  expect(settled.invoice.tipMinor).toBe(799);
  expect(settled.invoice.totalMinor).toBe(10000);
  expect(settled.payments.map((payment) => payment.amountMinor)).toEqual([10000]);
});

test("an over-payment against an invoice that already exists has nowhere to go", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await completeAppointment(request, tenant);
  const created = await request.post(`/api/appointments/${appointment.id}/checkout`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { discountMinor: 0, discountType: null, tipMinor: 0 }
  });
  expect(created.status()).toBe(201);

  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await openCheckout(page, appointment.id);

  await page.getByTestId("field-pay").fill("100.00");
  // No offer to fold it into the tip, because there is no longer a mechanism for one. The refusal
  // is the server's own arithmetic, said before the request rather than after it.
  await expect(page.getByTestId("checkout-remainder")).toBeHidden();
  await chooseMethod(page, "Cash");
  await page.getByTestId("checkout-submit").click();
  await expect(page.locator("#checkout-error")).toContainText("Payment exceeds invoice balance");
  const untouched = await invoiceFor(request, appointment.id);
  expect(untouched.payments).toHaveLength(0);
});

test("leaving a checkout with money entered asks first, and leaving an untouched one does not", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await completeAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await openCheckout(page, appointment.id);

  // Reading the bill and opening a disclosure cost nothing to abandon. A confirm here would be a
  // confirm on almost every dismissal, which is how an operator learns to click through them.
  await openAdjustment(page, "tip");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("checkout-surface")).toBeHidden();

  await openCheckout(page, appointment.id);
  await (await openAdjustment(page, "tip")).getByTestId("field-tip").fill("5");
  // Playwright dismisses an unhandled confirm, which is the operator answering "no".
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("checkout-surface")).toBeVisible();
  await expect(page.getByTestId("field-tip")).toHaveValue("5");

  const asked: string[] = [];
  page.once("dialog", async (dialog) => {
    asked.push(dialog.message());
    await dialog.accept();
  });
  await page.getByTestId("checkout-surface").locator("[data-surface-close]").click();
  await expect(page.getByTestId("checkout-surface")).toBeHidden();
  expect(asked[0]).toContain("Nothing has been charged");
});

test("a cashier who cannot grant money off keeps the coupon box and loses the amount", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await completeAppointment(request, tenant);
  const member = await createMember(request, `takes-money-${tenant.runId}@pawsh-test.example`, [
    "calendar.view",
    "appointments.view",
    "checkout.perform",
    "payments.view",
    "customers.view"
  ]);
  await login(page, member.email);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await openCheckout(page, appointment.id);

  // The split the server enforces: granting money off is `discounts.apply`, honouring a coupon the
  // customer brought is `checkout.perform`. A receptionist who could not honour one would be the
  // product's own rule getting in the way of the customer.
  await expect(page.locator('[data-checkout-disclosure="discount"]')).toHaveCount(0);
  await openAdjustment(page, "coupon");
  await expect(page.getByTestId("field-couponCode")).toBeVisible();
  await expect(page.getByTestId("field-discount")).toHaveCount(0);

  // Taking the money is still the thing they are here to do.
  await chooseMethod(page, "Cash");
  await page.getByTestId("checkout-submit").click();
  await expect(checkoutSurface(page).getByTestId("receipt")).toContainText("Balance$0.00");
});
