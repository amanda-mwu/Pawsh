import { test, expect, login, completeAppointment } from "./fixtures/tenant.js";
import { invoiceSurface } from "./helpers/invoice.js";
import { chooseMethod, checkoutSurface } from "./helpers/checkout.js";
import { voidRecord } from "./helpers/void-payment.js";
import { revealAppointmentOnCalendar } from "./helpers/calendar.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * QA PASS — THE APPOINTMENT SURFACE, CHECK OUT AND THE INVOICE, IN A BROWSER.
 *
 *   D1  a successful Take Payment says "Payment recorded" and throws nothing afterwards.
 *   D2  the Invoice of a voided payment offers Take Payment, and collecting it from there brings
 *       the workspace back settled.
 *   F1  on a phone with the keyboard up (the viewport 300px shorter), an inline note editor's Save
 *       is on screen and is the element under its own centre - not the surface's footer.
 *
 * The source-level half of each is `tests/ui/qa-pass-surface.test.ts`.
 */
const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  // A phone opens on today's day view and the fixture books on another day: the shared way to it.
  await revealAppointmentOnCalendar(page, appointmentId);
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

async function invoiceState(api: APIRequestContext, invoiceId: string): Promise<{ status: string; balanceMinor: number }> {
  const response = await api.get(`/api/invoices/${invoiceId}/receipt`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as { invoice: { status: string; balanceMinor: number } };
  return { status: payload.invoice.status, balanceMinor: payload.invoice.balanceMinor };
}

test("Take Payment records, toasts, throws nothing, and the voided invoice can be collected from itself",
  async ({ page, request, tenant }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const appointment = await completeAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    // ── D1 ──────────────────────────────────────────────────────────────────────────────────
    await detail(page).getByTestId("appointment-take-payment").click();
    await expect(checkoutSurface(page)).toBeVisible();
    await chooseMethod(page, "Cash");
    await page.getByTestId("checkout-submit").click();
    await expect(page.locator("#toast")).toHaveText("Payment recorded");
    await page.waitForTimeout(500);
    await expect(page.locator("#toast")).toHaveText("Payment recorded");
    expect(errors).toEqual([]);

    // ── D2 ──────────────────────────────────────────────────────────────────────────────────
    await checkoutSurface(page).locator("[data-surface-close]").click();
    await detail(page).getByTestId("appointment-invoice").click();
    await expect(invoiceSurface(page)).toBeVisible();
    await expect(invoiceSurface(page).getByTestId("invoice-take-payment")).toHaveCount(0);
    await voidRecord(page, invoiceSurface(page).getByRole("button", { name: "Void record" }), "QA pass: never handed over");
    const take = invoiceSurface(page).getByTestId("invoice-take-payment");
    await expect(take).toBeVisible();
    await expect(take).toHaveClass(/\bprimary\b/u);
    await expect(invoiceSurface(page).locator("footer .primary")).toHaveCount(1);
    // The not-built controls are utility, and the Receipt sentence is gone with the Receipt.
    await expect(invoiceSurface(page).locator(".surface-foot-utility [data-testid='invoice-send-receipt']")).toBeDisabled();
    await expect(invoiceSurface(page).getByTestId("invoice-unavailable-note")).not.toContainText("Print the Receipt");

    await take.click();
    await expect(checkoutSurface(page)).toBeVisible();
    await chooseMethod(page, "Cash");
    await page.getByTestId("checkout-submit").click();
    await expect(page.locator("#toast")).toHaveText("Payment recorded");
    await checkoutSurface(page).locator("[data-surface-close]").click();
    // Back on the invoice, re-read: settled, and the Receipt is printable again.
    await expect(invoiceSurface(page).getByTestId("invoice-balance")).toHaveText("Balance $0.00");
    await expect(invoiceSurface(page).getByTestId("invoice-print-receipt")).toBeVisible();
    await expect(invoiceSurface(page).getByTestId("invoice-take-payment")).toHaveCount(0);
    // The server agrees, on the one invoice this visit has.
    const visit = await request.get(`/api/appointments/${appointment.id}`);
    expect(visit.ok(), await visit.text()).toBeTruthy();
    const { invoiceId } = (await visit.json()) as { invoiceId: string };
    expect(await invoiceState(request, invoiceId)).toEqual({ status: "paid", balanceMinor: 0 });
    expect(errors).toEqual([]);
  });

for (const [width, height] of [[320, 568], [390, 844], [844, 390]] as const) {
  test(`the appointment note's Save is reachable with the keyboard up at ${width}x${height}`,
    async ({ page, request, tenant }) => {
      const appointment = await completeAppointment(request, tenant);
      await page.setViewportSize({ width, height });
      await login(page, tenant.ownerEmail);
      if (await page.locator("#mobile-nav-toggle").isVisible()) await page.locator("#mobile-nav-toggle").click();
      await openDetail(page, appointment.id);

      await detail(page).getByTestId("appointment-note-edit").click();
      await detail(page).getByTestId("appointment-note-record-input").focus();
      await page.setViewportSize({ width, height: Math.max(200, height - 300) });

      const save = detail(page).getByTestId("appointment-note-save");
      await expect(detail(page).locator(".surface-foot")).toBeHidden();
      await expect(async () => {
        const hit = await save.evaluate((button) => {
          const box = button.getBoundingClientRect();
          const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return { onScreen: box.top >= 0 && box.bottom <= innerHeight, hit: top === button };
        });
        expect(hit).toEqual({ onScreen: true, hit: true });
      }).toPass();

      // Leaving the editor brings the footer back.
      await detail(page).getByTestId("appointment-note-cancel").click();
      await page.setViewportSize({ width, height });
      await expect(detail(page).locator(".surface-foot")).toBeVisible();
    });
}

