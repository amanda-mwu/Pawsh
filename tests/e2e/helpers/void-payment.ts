import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Voiding a payment record, through PAWSH'S dialog rather than the browser's.
 *
 * This used to be two browser dialogs in a row — a `prompt` for the reason and then a `confirm`
 * for the warning — which a spec answered with a `page.on("dialog", …)` handler that had to sort
 * one from the other by `dialog.type()`. Both are now one `#stacked-dialog`: the warning is the
 * sentence at the top and the reason is the field under it, so a spec fills the field and presses
 * the one confirm.
 *
 * The warning is RETURNED because it is a claim several specs make — the credit sentence names the
 * money going back onto the balance, the Pawsh-record sentence says no external funds move — and
 * those assertions used to be made against the collected `dialog.message()`s.
 *
 * Waiting for the warning to go before returning matters: the void is sent as the dialog closes,
 * and the balance the caller asserts next is the balance AFTER the receipt was re-read.
 */
export async function voidRecord(page: Page, trigger: Locator, reason: string): Promise<string> {
  await trigger.click();
  const dialog = page.getByTestId("stacked-dialog");
  const warning = dialog.getByTestId("void-payment-warning");
  await expect(warning).toBeVisible();
  const stated = (await warning.textContent()) ?? "";
  await dialog.getByTestId("field-voidReason").fill(reason);
  await dialog.getByTestId("stacked-dialog-confirm").click();
  await expect(warning).toBeHidden();
  return stated;
}
