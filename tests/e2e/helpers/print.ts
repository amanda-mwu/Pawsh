import type { Page } from "@playwright/test";

/**
 * Print, made observable.
 *
 * `printTicket` and `printFinancialDocument` append a `.print-root` to <body>, call `print()` and
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

/** Clears the kept roots, so one print does not stand between the next assertion and the app. */
export async function clearPrintRoots(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const root of document.querySelectorAll(".print-root")) root.parentNode?.removeChild(root);
  });
}
