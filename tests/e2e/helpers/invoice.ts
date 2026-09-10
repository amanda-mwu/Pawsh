import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The Invoice, as a surface rather than as a dialog.
 *
 * It used to be drawn into the shared `#modal` — a 650px form dialog — so every spec that reached
 * the Invoice reached it through `page.getByTestId("modal")` and read its title off `#modal-title`.
 * It is a level of the appointment surface stack now, with its own `<dialog>`, its own heading and
 * its own footer, and these three helpers are where that fact lives so that a spec asserting what
 * the Invoice SAYS does not also have to know how it is opened.
 */
export function invoiceSurface(page: Page): Locator {
  return page.getByTestId("invoice-surface");
}

/** What the document calls itself, read off the heading the surface is labelled by. */
export function invoiceTitle(page: Page): Locator {
  return invoiceSurface(page).getByTestId("invoice-document-title");
}

/** The shared money statement, in the workspace's left-hand column. */
export function invoiceStatement(page: Page): Locator {
  return invoiceSurface(page).locator(".receipt");
}

/**
 * Opens one invoice from a client's transaction history.
 *
 * The history list is `#modal` and the Invoice takes the whole viewport, so the list is dismissed
 * as the Invoice opens. Both halves are asserted here: a spec that only waited for the surface
 * would pass while a stale history dialog sat underneath it.
 */
export async function openInvoiceFromHistory(page: Page, invoiceId: string): Promise<Locator> {
  const modal = page.getByTestId("modal");
  await modal.locator(`[data-testid="history-invoice"][data-invoice-id="${invoiceId}"]`).click();
  const surface = invoiceSurface(page);
  await expect(surface).toBeVisible();
  await expect(modal).toBeHidden();
  return surface;
}

/** Closes it the way an operator does, from the X in its head. */
export async function closeInvoice(page: Page): Promise<void> {
  await invoiceSurface(page).locator("[data-surface-close]").click();
  await expect(invoiceSurface(page)).toBeHidden();
}
