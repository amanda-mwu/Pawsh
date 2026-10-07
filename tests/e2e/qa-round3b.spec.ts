import { test, expect, login, completeAppointment, prepareReceipt } from "./fixtures/tenant.js";
import type { APIRequestContext, Page } from "@playwright/test";
import { revealAppointmentOnCalendar } from "./helpers/calendar.js";

/**
 * QA ROUND 3B, IN A BROWSER: services editable until a payment, one Invoice surface whose actions
 * follow the settlement, the Ticket in the head, and Messages on a phone.
 *
 * `tests/ui/qa-round3b.test.ts` runs the predicates and the markup as written; this file walks
 * them against the real routes.
 */

const detail = (page: Page) => page.getByTestId("appointment-detail-surface");
const invoiceSurface = (page: Page) => page.getByTestId("invoice-surface");

async function openCalendar(page: Page): Promise<void> {
  if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-calendar").isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await openCalendar(page);
  await revealAppointmentOnCalendar(page, appointmentId);
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).filter({ visible: true }).first().click();
  await expect(detail(page)).toBeVisible();
}

async function raiseInvoice(api: APIRequestContext, appointmentId: string): Promise<{ id: string; balanceMinor: number }> {
  const response = await api.post(`/api/appointments/${appointmentId}/checkout`, {
    headers: { "Idempotency-Key": crypto.randomUUID() }, data: { discountMinor: 0, discountType: "manual", tipMinor: 0 }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<{ id: string; balanceMinor: number }>;
}

// ─── 1 · services editable until a payment ───────────────────────────────────────────────────

test("an invoiced, unpaid visit's services stay editable, and an edit re-prices the bill", async ({ page, request, tenant }) => {
  const visit = await completeAppointment(request, tenant);
  const invoice = await raiseInvoice(request, visit.id);
  await login(page, tenant.ownerEmail);
  await openDetail(page, visit.id);

  await expect(detail(page).getByTestId("appointment-adjust-services")).toBeEnabled();
  await expect(detail(page).getByTestId("appointment-services-locked")).toHaveCount(0);
  const pencil = detail(page).getByTestId("appointment-service-edit").first();
  await expect(pencil).toBeEnabled();

  // Re-price the one line by $10.00: the bill follows, on the surface, without a reload.
  await pencil.click();
  const price = page.locator("#modal input[name=price]");
  const before = Number(await price.inputValue());
  await price.fill((before + 10).toFixed(2));
  // The server re-prices the bill - tax included - so the figure expected on the chip is the one
  // the edit's own response carries, and it has to have moved from what the invoice said before.
  const saved = page.waitForResponse((response) => /\/api\/appointments\/[^/]+\/services\//u.test(response.url()) && response.request().method() === "PATCH");
  await page.locator("#modal").getByRole("button", { name: /save/iu }).click();
  const repriced = await (await saved).json() as { invoiceBalanceMinor: number; invoiceStatus: string };
  expect(repriced.invoiceStatus).toBe("open");
  expect(repriced.invoiceBalanceMinor).toBeGreaterThan(invoice.balanceMinor + 1000 - 1);
  await expect(page.locator("#modal")).toBeHidden();
  await expect(detail(page).getByTestId("appointment-billing")).toContainText(`$${(repriced.invoiceBalanceMinor / 100).toFixed(2)} due`);
  await expect(detail(page).locator('.activity-entry[data-action="invoice.recalculate"]').first())
    .toContainText(/Invoice recalculated[\s\S]*New total \$/u);
});

test("a recorded payment locks the services, on the surface and on the card menu, with the way to undo it", async ({ page, request, tenant }) => {
  const { appointment } = await prepareReceipt(request, tenant);
  await login(page, tenant.ownerEmail);
  await openDetail(page, appointment.id);
  await expect(detail(page).getByTestId("appointment-adjust-services")).toBeDisabled();
  await expect(detail(page).getByTestId("appointment-services-locked"))
    .toHaveText("Services are locked once a payment is recorded. Void the payment to change them.");
  await detail(page).locator("[data-surface-close]").click();

  const card = page.locator(`#calendar-list [data-appointment-id="${appointment.id}"]`).filter({ visible: true }).first();
  const trigger = card.locator(".calendar-action-trigger");
  test.skip(!(await trigger.isVisible()), "phones hide the card menu");
  await trigger.click();
  const menu = page.locator(".calendar-action-popover:not([hidden])");
  await expect(menu.locator(".service-action")).toBeDisabled();
  await expect(menu.locator(".calendar-action-reason")).toHaveText("Services are locked once a payment is recorded. Void the payment to change them.");
});

// ─── 2 · one Invoice surface; the Ticket in the head ─────────────────────────────────────────

test("View Invoice opens the same Invoice for an unpaid bill, with no receipt actions", async ({ page, request, tenant }) => {
  const visit = await completeAppointment(request, tenant);
  await raiseInvoice(request, visit.id);
  await login(page, tenant.ownerEmail);
  await openDetail(page, visit.id);
  const view = detail(page).getByTestId("appointment-invoice");
  await expect(view).toHaveText("View Invoice");
  await view.click();
  await expect(invoiceSurface(page)).toBeVisible();
  await expect(invoiceSurface(page).getByTestId("invoice-print-invoice")).toBeVisible();
  await expect(invoiceSurface(page).getByTestId("invoice-take-payment")).toBeVisible();
  for (const testid of ["invoice-print-receipt", "invoice-send-receipt", "invoice-ask-review", "invoice-unavailable-note"]) {
    await expect(invoiceSurface(page).getByTestId(testid), testid).toHaveCount(0);
  }
});

test("a paid bill offers Print Invoice and the three receipt actions, and Balance $0.00", async ({ page, request, tenant }) => {
  const { appointment } = await prepareReceipt(request, tenant);
  await login(page, tenant.ownerEmail);
  await openDetail(page, appointment.id);
  await detail(page).getByTestId("appointment-invoice").click();
  await expect(invoiceSurface(page)).toBeVisible();
  await expect(invoiceSurface(page).getByTestId("invoice-balance")).toContainText("Balance $0.00");
  for (const testid of ["invoice-print-invoice", "invoice-print-receipt", "invoice-send-receipt", "invoice-ask-review"]) {
    await expect(invoiceSurface(page).getByTestId(testid), testid).toBeVisible();
  }
  await expect(invoiceSurface(page).getByTestId("invoice-take-payment")).toHaveCount(0);
  // Print Receipt still opens the full-screen Receipt; the Invoice and the Receipt stay separate.
  await invoiceSurface(page).getByTestId("invoice-print-receipt").click();
  await expect(page.getByTestId("receipt-document")).toBeVisible();
});

test("Print Ticket is the printer icon in the appointment head, and nowhere in the footer", async ({ page, request, tenant }) => {
  const visit = await completeAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await openDetail(page, visit.id);
  const ticket = detail(page).getByRole("button", { name: "Print Ticket" });
  await expect(ticket).toHaveCount(1);
  await expect(detail(page).locator(".surface-head [data-testid='appointment-ticket']")).toBeVisible();
  await expect(detail(page).locator("footer [data-testid='appointment-ticket']")).toHaveCount(0);
  await ticket.click();
  await expect(page.locator("#appointment-ticket")).toBeVisible();
});

// ─── 3 · Messages on a phone ─────────────────────────────────────────────────────────────────

test.describe("Messages on a phone", () => {
  test.use({ viewport: { width: 400, height: 860 } });

  test("search and tabs full width on top, the list below; a client is its own screen with an arrow back", async ({ page, tenant }) => {
    await login(page, tenant.ownerEmail);
    if (await page.locator("#mobile-nav-toggle").isVisible()) await page.locator("#mobile-nav-toggle").click();
    await page.getByTestId("nav-messages").click();
    const pane = page.locator(".message-list-pane");
    const [paneBox, searchBox, tabsBox, listBox] = await Promise.all(
      [pane, page.locator("#message-search"), page.locator(".message-filters"), page.locator("#message-client-list")].map((each) => each.boundingBox())
    );
    // Full width, stacked: nothing sits beside the search.
    for (const box of [searchBox, tabsBox, listBox]) expect(box!.width).toBeGreaterThan(paneBox!.width - 40);
    expect(listBox!.y).toBeGreaterThan(tabsBox!.y);
    // The tabs scroll sideways rather than being clipped.
    await expect(page.locator(".message-filters")).toHaveCSS("overflow-x", "auto");
    await expect(page.locator("#message-thread")).toBeHidden();

    await page.locator("#message-client-list [data-message-client]").first().click();
    await expect(pane).toBeHidden();
    await expect(page.locator("#message-thread")).toBeVisible();
    await expect(page.locator("#message-client-context")).toBeVisible();
    await page.getByRole("button", { name: "Back to clients" }).click();
    await expect(pane).toBeVisible();
    await expect(page.locator("#message-thread")).toBeHidden();
    await expect(page.locator("#message-client-list [data-message-client].active")).toBeFocused();
  });
});
