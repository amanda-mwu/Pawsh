import { expect, type Locator, type Page } from "@playwright/test";
import { appointmentAction } from "../fixtures/tenant.js";

/**
 * Driving Check Out, which is a full-screen `<dialog id="appointment-checkout">` rather than the
 * shared modal.
 *
 * The adjustments — a manual discount, the configured picker, a coupon code, a tip — live behind
 * disclosure links, because the common case at a counter is "take the money" and a screen that
 * opens with four editors is a screen that has to be read before it can be used. A spec that wants
 * one of them therefore opens it the way an operator would.
 */

export const checkoutSurface = (page: Page): Locator => page.getByTestId("checkout-surface");

/** Opens Check Out from the calendar's own action menu, the way a front desk does. */
export async function openCheckout(page: Page, appointmentId: string): Promise<Locator> {
  const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
  await (await appointmentAction(card, "appointment-completed")).click();
  const surface = checkoutSurface(page);
  await expect(surface).toBeVisible();
  return surface;
}

/** Expands one adjustment disclosure and returns its body. */
export async function openAdjustment(
  page: Page,
  id: "discount" | "coupon" | "tip"
): Promise<Locator> {
  const disclosure = page.locator(`[data-checkout-disclosure="${id}"]`);
  await expect(disclosure).toBeVisible();
  if (!(await disclosure.evaluate((node: HTMLDetailsElement) => node.open))) {
    await disclosure.locator("summary").click();
  }
  await expect(disclosure).toHaveAttribute("open", "");
  return disclosure.locator(".checkout-disclosure-body");
}

/**
 * Picks a payment method. Two to six configured methods render as radios; past that Check Out
 * falls back to the select, so this covers both without the caller knowing which is on screen.
 */
export async function chooseMethod(page: Page, label: string): Promise<void> {
  const group = page.getByTestId("field-method");
  if ((await group.evaluate((node) => node.tagName)) === "SELECT") {
    await group.selectOption({ label });
    return;
  }
  await group.locator("label", { hasText: label }).locator("input").check();
}

/** Fills the amount to take. Absent while a card terminal or a coupon is in play. */
export async function setPayAmount(page: Page, amount: string): Promise<void> {
  await page.getByTestId("field-pay").fill(amount);
}
