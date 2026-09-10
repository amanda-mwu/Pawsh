import { expect, type Page } from "@playwright/test";

/**
 * Print, made observable.
 *
 * `printTicket`, `printInvoiceDocument` and `printPaymentReceipt` append a `.print-root` to
 * <body>, call `print()` and
 * remove the root 1000ms later. Neither of those is something a browser test can wait on, so the
 * dialog is stubbed out and the root is kept: `Element.prototype.remove` is neutered FOR PRINT
 * ROOTS ONLY, which leaves every other removal in the client — the checkout's withdrawn controls,
 * the terminal device select — working exactly as it does in production. Nothing about how the
 * root is BUILT is touched, which is the part under test.
 *
 * Must be called before the page navigates, because it installs an init script.
 */
export async function observePrinting(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "print", { value: () => {}, writable: true });
    const remove = Element.prototype.remove;
    Element.prototype.remove = function (this: Element) {
      if (this.classList?.contains("print-root")) return;
      remove.call(this);
    };
  });
}

/**
 * THE PREVIEW STEP, PRESSED THROUGH.
 *
 * Print Invoice, Print Receipt, Ticket and Print no longer reach `appendPrintRoot` on the press:
 * they open `previewPrintRoot`'s in-app preview over the dialog they were pressed from, and Print
 * inside it is what puts the document on paper. A spec that asserts on `.print-root` is therefore
 * two presses away from paper rather than one, and this is the second press.
 *
 * It asserts the preview arrived before pressing, so a document that skipped the preview fails
 * here rather than somewhere further down the spec, and waits for it to close, so the assertions
 * after it run against a screen that has settled back onto the window underneath.
 */
export async function printFromPreview(page: Page): Promise<void> {
  const preview = page.getByTestId("print-preview");
  await expect(preview).toBeVisible();
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(preview).toBeHidden();
}

/** Leaves the preview without printing, which is what the X and Close do. */
export async function closePreview(page: Page): Promise<void> {
  const preview = page.getByTestId("print-preview");
  await expect(preview).toBeVisible();
  await page.getByTestId("stacked-dialog-close").click();
  await expect(preview).toBeHidden();
}

/** Clears the kept roots, so one print does not stand between the next assertion and the app. */
export async function clearPrintRoots(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const root of document.querySelectorAll(".print-root")) root.parentNode?.removeChild(root);
  });
}
