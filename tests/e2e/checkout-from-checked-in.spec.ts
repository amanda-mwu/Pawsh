import { test, expect, login, createAppointment } from "./fixtures/tenant.js";
import { checkoutSurface, chooseMethod } from "./helpers/checkout.js";
import { revealAppointmentOnCalendar } from "./helpers/calendar.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * A PET THAT IS HERE CAN BE PAID FOR, AND PAYING FOR IT DOES NOT SEND IT HOME.
 *
 * Checkout required `completed`, so an operator who wanted to take payment at drop-off had to
 * first mark the grooming finished — recording work that had not happened in order to record
 * money that had. The visit's own history then said the dog left before it was washed.
 *
 * WHY THIS IS A BROWSER SPEC. The eligibility rule itself is held deterministically twice over:
 * `tests/database/checkout-eligibility.test.ts` puts the route through all six statuses, and
 * `tests/ui/checkout-eligibility.test.ts` runs the footer's real `derive()` against
 * `canEnterCheckout`. Three things cannot be asserted in either, and are what this walk is for:
 *
 *   THE TWO GATES AGREE IN A RUNNING PRODUCT. The footer offers Take Payment on a checked-in
 *       visit and the route it opens accepts it — one page, one server, no fixture in between.
 *   THE STATUS SURVIVES THE WHOLE WALK. `checked_in` is read back off the server after the
 *       invoice is raised AND after it is settled, because the claim is about an absence: no
 *       step of taking money moved the visit.
 *   ONE INVOICE. Every `POST /api/appointments/:id/checkout` the page sends is counted.
 *
 * NOT IN SCOPE and deliberately untouched: the Ready for Pickup control, the checked-in footer's
 * layout, client credit, and the settlement model. This walk presses what is already there.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");
const takePayment = (page: Page): Locator => detail(page).getByTestId("appointment-take-payment");

/** A visit that has arrived and nothing more. */
async function checkInAppointment(api: APIRequestContext, tenant: { locationId: string }) {
  const appointment = await createAppointment(api, tenant as never);
  const response = await api.post(`/api/appointments/${appointment.id}/transition`, {
    data: { status: "checked_in", version: appointment.version }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { ...appointment, version: ((await response.json()) as { version: number }).version };
}

/** What the server says the visit's status is, which is the only authority on it. */
async function statusOf(api: APIRequestContext, appointmentId: string): Promise<string> {
  const response = await api.get(`/api/appointments/${appointmentId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { status: string }).status;
}

async function invoiceState(api: APIRequestContext, invoiceId: string): Promise<{
  status: string; balanceMinor: number;
}> {
  const response = await api.get(`/api/invoices/${invoiceId}/receipt`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as { invoice: { status: string; balanceMinor: number } };
  return { status: payload.invoice.status, balanceMinor: payload.invoice.balanceMinor };
}

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await revealAppointmentOnCalendar(page, appointmentId);
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

test("@regression-checkout a checked-in visit can be billed and settled without being completed",
  async ({ page, request, tenant }) => {
    const appointment = await checkInAppointment(request, tenant);
    expect(await statusOf(request, appointment.id)).toBe("checked_in");

    await login(page, tenant.ownerEmail);

    const checkoutPosts: string[] = [];
    page.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST"
        && /\/api\/appointments\/[^/]+\/checkout$/u.test(new URL(outgoing.url()).pathname)
      ) checkoutPosts.push(outgoing.url());
    });

    // ── 1. THE FOOTER OFFERS IT ────────────────────────────────────────────────────────────────
    await openDetail(page, appointment.id);
    await expect(page.getByTestId("appointment-billing")).toHaveText("Not invoiced");
    await expect(takePayment(page)).toBeVisible();
    await expect(takePayment(page)).toHaveClass(/primary/u);
    // Exactly one primary action. Save is the primary on a visit still being worked and had never
    // been drawn beside Take Payment before; the footer's own rule decides which keeps the slot.
    await expect(detail(page).locator("footer .primary")).toHaveCount(1);

    // ── 2. THE ROUTE ACCEPTS IT ────────────────────────────────────────────────────────────────
    await takePayment(page).click();
    await expect(checkoutSurface(page)).toBeVisible();

    // ONE PRESS DOES BOTH: Check Out in `build` mode raises the invoice and then tenders against
    // it, so both responses are awaited rather than only the first - otherwise the settlement
    // assertion below reads the invoice in the instant between them.
    const raised = page.waitForResponse((response) =>
      /\/api\/appointments\/[^/]+\/checkout$/u.test(new URL(response.url()).pathname)
      && response.request().method() === "POST");
    const tendered = page.waitForResponse((response) =>
      /\/api\/invoices\/[^/]+\/payments$/u.test(new URL(response.url()).pathname)
      && response.request().method() === "POST");
    await chooseMethod(page, "Cash");
    await page.getByTestId("checkout-submit").click();
    const invoice = (await (await raised).json()) as { id: string };
    expect((await tendered).ok(), "the tender was refused").toBeTruthy();

    // ── 3. THE VISIT DID NOT MOVE ──────────────────────────────────────────────────────────────
    // Settled by the server's own answer, not by the screen: the money is recorded and the pet is
    // still in the salon. Whoever hands it back says so separately.
    expect(await invoiceState(request, invoice.id)).toEqual({ status: "paid", balanceMinor: 0 });
    expect(await statusOf(request, appointment.id)).toBe("checked_in");

    // ── 4. ONE INVOICE, RAISED ONCE ────────────────────────────────────────────────────────────
    expect(checkoutPosts).toHaveLength(1);
    const invoices = await request.get(`/api/appointments/${appointment.id}`);
    expect(((await invoices.json()) as { invoiceId: string }).invoiceId).toBe(invoice.id);
  });

test("@regression-checkout a scheduled visit is not offered a checkout the route would refuse",
  async ({ page, request, tenant }) => {
    const appointment = await createAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    await expect(takePayment(page)).toHaveCount(0);
    // And the route agrees, so the footer is withholding a refusal rather than hiding a capability.
    const refused = await request.post(`/api/appointments/${appointment.id}/checkout`, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { discountMinor: 0, discountType: null, tipMinor: 0 }
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe("STALE_FINANCIAL_STATE");
  });

/**
 * THE WORKSPACE AT BOTH ENDS OF THE RANGE.
 *
 * On a desk it is two columns and the bill has the width, because reading what is being charged
 * is what the left side is for. On a phone at a counter it is one column with the MONEY FIRST -
 * the operator opened this to take an amount, not to read the bill back - and the bill follows
 * underneath. What must never happen at either end is the page scrolling sideways.
 */
test("@responsive the checkout workspace lays out on a desk and collapses on a phone",
  async ({ page, request, tenant }) => {
    const appointment = await checkInAppointment(request, tenant);
    await login(page, tenant.ownerEmail);

    await page.setViewportSize({ width: 1440, height: 900 });
    await openDetail(page, appointment.id);
    await takePayment(page).click();
    await expect(checkoutSurface(page)).toBeVisible();

    const geometry = async () => page.evaluate(() => {
      const body = document.querySelector(".checkout-body") as HTMLElement;
      const bill = document.querySelector(".checkout-bill") as HTMLElement;
      const pay = document.querySelector(".checkout-money") as HTMLElement;
      return {
        columns: getComputedStyle(body).gridTemplateColumns.split(" ").length,
        billTop: Math.round(bill.getBoundingClientRect().top),
        payTop: Math.round(pay.getBoundingClientRect().top),
        billWidth: Math.round(bill.getBoundingClientRect().width),
        payWidth: Math.round(pay.getBoundingClientRect().width),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });

    const desk = await geometry();
    expect(desk.columns, "two columns on a desk").toBe(2);
    // Side by side, and the bill has the width rather than leaving it unused beside the form.
    expect(desk.billTop).toBe(desk.payTop);
    expect(desk.billWidth).toBeGreaterThan(desk.payWidth);
    expect(desk.overflow, "the page must never scroll sideways").toBeLessThanOrEqual(0);

    await page.setViewportSize({ width: 390, height: 844 });
    const phone = await geometry();
    expect(phone.columns, "one column on a phone").toBe(1);
    // MONEY FIRST. The bill is below it, not scrolled past to reach it.
    expect(phone.payTop).toBeLessThan(phone.billTop);
    expect(phone.overflow, "the page must never scroll sideways").toBeLessThanOrEqual(0);
    // And the thing the operator came for is still reachable.
    await expect(page.getByTestId("checkout-submit")).toBeVisible();
  });
