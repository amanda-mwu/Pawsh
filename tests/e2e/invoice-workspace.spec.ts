import { test, expect, login, completeAppointment } from "./fixtures/tenant.js";
import { observePrinting, clearPrintRoots, printFromPreview } from "./helpers/print.js";
import {
  closeInvoice, invoiceStatement, invoiceSurface, invoiceTitle, openInvoiceFromHistory
} from "./helpers/invoice.js";
import { expectCriticalTarget, expectNoDocumentOverflow } from "./helpers/responsive.js";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * THE INVOICE IS A WORKSPACE, AT EVERY DOOR AND AT EVERY WIDTH.
 *
 * It used to be a 650px `#modal`: a form dialog, with a two-column FIELD grid, a footer belonging
 * to a form, and a green Save that saved nothing. On a desktop that meant a narrow centred column
 * of simulated paper with most of the screen empty beside it, and the two controls that matter —
 * Print Invoice and Print Receipt — below the bottom of a document the operator had to scroll
 * past to reach them.
 *
 * It is a full-screen surface now, on the same stack the appointment detail, Check Out and the
 * Ticket are on. This spec is the browser half of that: what the deterministic
 * `tests/ui/invoice-workspace.test.ts` cannot answer because it needs layout, a viewport and a
 * navigation history.
 *
 *   1. the desktop workspace, opened from the appointment, uses the viewport and splits in two
 *   2. Print Invoice → an Invoice preview → paper, and Print Receipt → a RECEIPT preview → paper,
 *      with no Ticket anywhere on either route
 *   3. closing it returns the operator to the context they opened it from — the visit from the
 *      appointment footer, the transaction list from a client's history
 *   4. a narrow viewport collapses to one column, keeps the actions reachable, and overflows
 *      nowhere
 *
 * WHAT THE DOCUMENTS SAY is not re-asserted here. `tests/e2e/invoice-receipt-identity.spec.ts`
 * walks the settlement states and `tests/ui/payment-receipt.test.ts` holds every figure on both
 * financial documents. This spec is about the container and the route.
 */

const detail = (page: Page) => page.getByTestId("appointment-detail-surface");
const printRoot = (page: Page) => page.locator(".print-root");

/** Raises and settles the invoice through the API, so its figures are fixed before the browser. */
async function settledInvoice(api: APIRequestContext, appointmentId: string): Promise<{
  id: string; invoiceNumber: number;
}> {
  const raised = await api.post(`/api/appointments/${appointmentId}/checkout`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { discountMinor: 500, discountType: "manual", tipMinor: 1500 }
  });
  expect(raised.ok(), await raised.text()).toBeTruthy();
  const invoice = (await raised.json()) as {
    id: string; invoiceNumber: number; balanceMinor: number;
  };
  const paid = await api.post(`/api/invoices/${invoice.id}/payments`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {
      amountMinor: invoice.balanceMinor, expectedBalanceMinor: invoice.balanceMinor, method: "cash"
    }
  });
  expect(paid.ok(), await paid.text()).toBeTruthy();
  return invoice;
}

/**
 * The preview window's own name.
 *
 * `#stacked-dialog-title` is the <h4> the head X is appended INTO — one dismissal drawn in the
 * corner a window closes from — so the heading's text ends in that glyph. The name is what is
 * asserted, so the control that shares the element is trimmed off rather than asserted around.
 */
async function previewName(page: Page): Promise<string> {
  return (await page.locator("#stacked-dialog-title").evaluate((node) => {
    const copy = node.cloneNode(true) as HTMLElement;
    copy.querySelector("[data-testid='stacked-dialog-close']")?.remove();
    return copy.textContent ?? "";
  })).trim();
}

/** Opens the client's transaction history, which is the second door into the same Invoice. */
async function openTransactionHistory(page: Page): Promise<void> {
  // Below 580px the primary nav collapses behind a toggle, so a phone reaches Clients the way
  // an operator does rather than through a control that is not on screen.
  if (await page.locator("#mobile-nav-toggle").isVisible()
    && await page.getByTestId("nav-customers").isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
  await page.getByTestId("nav-customers").click();
  const customer = page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" });
  await customer.getByTestId("client-row-actions").click();
  await customer.getByTestId("client-appointment-history").click();
  await expect(page.getByTestId("modal")).toContainText("Transactions");
}

test("the desktop Invoice is a workspace, and both print routes carry their own identity",
  async ({ page, request, tenant }) => {
    await observePrinting(page);
    const appointment = await completeAppointment(request, tenant);
    const invoice = await settledInvoice(request, appointment.id);
    await login(page, tenant.ownerEmail);

    // ---- Door 1: the appointment footer ------------------------------------------------------
    await page.getByTestId("nav-calendar").click();
    await page.waitForLoadState("networkidle");
    await page.locator(`[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();
    await expect(detail(page)).toBeVisible();
    await detail(page).getByTestId("appointment-invoice").click();

    const document_ = invoiceSurface(page);
    await expect(document_).toBeVisible();
    await expect(invoiceTitle(page)).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    // NOT THE FORM DIALOG. `#modal` still exists and still hosts Move, Adjust services and the
    // client history — it simply is not where a financial document lives any more.
    await expect(page.getByTestId("modal")).toBeHidden();

    // ---- The workspace uses the screen it was given ------------------------------------------
    const viewport = page.viewportSize()!;
    const shell = (await document_.locator(".surface-shell").boundingBox())!;
    // Nearly the whole viewport, not a 650px column with the rest of the desktop empty beside it.
    expect(shell.width).toBeGreaterThan(viewport.width * 0.9);
    // Two columns: the statement on the left, where the invoice stands on the right.
    const statement = (await document_.getByTestId("invoice-statement").boundingBox())!;
    const summary = (await document_.getByTestId("invoice-summary").boundingBox())!;
    expect(summary.x).toBeGreaterThan(statement.x + statement.width - 1);
    // And the statement holds a readable measure rather than stretching a money line across the
    // whole desk: wide screen, wide workspace, and a document that still reads as a document.
    const receipt = (await invoiceStatement(page).boundingBox())!;
    expect(receipt.width).toBeLessThan(statement.width);

    // ---- The actions are reachable WITHOUT scrolling past the document -----------------------
    // The footer is the shell's own row, outside the body's scroller, so it is on screen the
    // moment the Invoice is. This is the defect the conversion exists for.
    for (const action of ["invoice-print-invoice", "invoice-print-receipt"]) {
      await expect(document_.getByTestId(action), action).toBeInViewport();
    }
    // The balance, stated in the footer beside them, so the operator never has to scroll to find
    // out whether anything is still owed.
    await expect(document_.getByTestId("invoice-balance")).toContainText("Balance $0.00");

    // ---- THE TWO CAPABILITIES PAWSH DOES NOT HAVE YET ---------------------------------------
    // Send Receipt and Ask for Review exist nowhere in this product yet: no control, no route, no
    // template, no notification type. Both are planned. Drawn and disabled with a reason, rather
    // than hidden, so an operator looking for them finds out why instead of hunting a screen that
    // omits them.
    for (const unavailable of ["invoice-send-receipt", "invoice-ask-review"]) {
      const control = document_.getByTestId(unavailable);
      await expect(control, unavailable).toBeVisible();
      await expect(control, unavailable).toBeDisabled();
      await expect(control, unavailable).toHaveAttribute("aria-disabled", "true");
    }
    // A STATE OF THE PRODUCT, not of this actor and not of this invoice — the three unavailable
    // things around this footer have three different reasons and three different sentences.
    // `tests/ui/invoice-workspace.test.ts` pins the meaning clause by clause; what matters here
    // is that the sentence is actually on screen rather than only in a `title` a phone cannot
    // show and a keyboard cannot reach.
    const note = document_.getByTestId("invoice-unavailable-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText(/not built yet/iu);
    await expect(note).toContainText(/planned/iu);
    await expect(note).not.toContainText(/permission/iu);
    // Pressing one does nothing at all — no dialog, no navigation, no toast. The document behind
    // it is exactly where it was.
    await document_.getByTestId("invoice-ask-review").click({ force: true });
    await expect(invoiceTitle(page)).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    await expect(page.getByTestId("stacked-dialog")).toBeHidden();

    // ---- Print Invoice → an INVOICE preview → paper ------------------------------------------
    await document_.getByTestId("invoice-print-invoice").click();
    await expect(page.getByTestId("print-preview")).toBeVisible();
    expect(await previewName(page)).toBe(`Print preview: Invoice #${invoice.invoiceNumber}`);
    await expect(page.getByTestId("print-preview").getByTestId("ticket-document")).toHaveCount(0);
    await printFromPreview(page);
    await expect(printRoot(page).locator("h1")).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    await clearPrintRoots(page);
    // Back on the Invoice, which is where it was pressed from.
    await expect(document_).toBeVisible();

    // ---- Print Receipt → a RECEIPT preview → paper, and NEVER a Ticket dialog ----------------
    await document_.getByTestId("invoice-print-receipt").click();
    const preview = page.getByTestId("print-preview");
    await expect(preview).toBeVisible();
    expect(await previewName(page)).toBe(`Print preview: Receipt #${invoice.invoiceNumber}`);
    // THE PREVIEW IS THE RECEIPT. Not the Ticket — which is the shop's operational work sheet and
    // carries no money at all — and not the Invoice's own statement retitled.
    await expect(preview.getByTestId("payment-receipt")).toHaveCount(1);
    await expect(preview.getByTestId("ticket-document")).toHaveCount(0);
    await expect(preview.locator(".receipt")).toHaveCount(0);
    await expect(preview).not.toContainText("Ticket");
    await expect(preview).toContainText("Total settled");
    // It references the invoice it evidences. Pawsh has no separate receipt series and inventing
    // one would be an identifier nothing reconciles against.
    await expect(preview.locator("h1")).toHaveText(`Receipt #${invoice.invoiceNumber}`);
    // And Print from inside it is what reaches the print path.
    await printFromPreview(page);
    await expect(printRoot(page).locator("h1")).toHaveText(`Receipt #${invoice.invoiceNumber}`);
    await expect(printRoot(page).getByTestId("payment-receipt")).toHaveCount(1);
    await expect(printRoot(page).getByTestId("ticket-document")).toHaveCount(0);
    await clearPrintRoots(page);

    // ---- Closing it puts the operator back on the visit --------------------------------------
    await closeInvoice(page);
    await expect(detail(page)).toBeVisible();
    await expect(page.getByTestId("appointment-billing")).toHaveText("Paid");
  });

test("the same workspace opens from a client's transaction history, and closes back onto it",
  async ({ page, request, tenant }) => {
    const appointment = await completeAppointment(request, tenant);
    const invoice = await settledInvoice(request, appointment.id);
    await login(page, tenant.ownerEmail);

    await openTransactionHistory(page);
    const document_ = await openInvoiceFromHistory(page, invoice.id);

    // ONE IMPLEMENTATION, EVERY DOOR. The same element, the same heading, the same two print
    // controls under the same two gates — not a second invoice screen for a second entry point.
    await expect(invoiceTitle(page)).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    await expect(document_.getByTestId("invoice-print-invoice")).toBeVisible();
    await expect(document_.getByTestId("invoice-print-receipt")).toBeVisible();
    await expect(document_.getByTestId("invoice-statement")).toBeVisible();
    await expect(document_.getByTestId("invoice-summary")).toBeVisible();

    // ESCAPE IS THE SAME DISMISSAL THE X IS, and it comes back to the transactions the operator
    // was working through rather than to the client card two steps behind them.
    await page.keyboard.press("Escape");
    await expect(invoiceSurface(page)).toBeHidden();
    await expect(page.getByTestId("modal")).toBeVisible();
    await expect(page.getByTestId("modal")).toContainText("Transactions");
    await expect(page.getByTestId("modal")).toContainText(`Invoice ${invoice.invoiceNumber}`);
  });

test("a narrow viewport collapses the workspace to one column and overflows nowhere",
  async ({ page, request, tenant }, testInfo) => {
    const appointment = await completeAppointment(request, tenant);
    const invoice = await settledInvoice(request, appointment.id);
    // A small phone, set before sign-in so nothing lays out at a width the operator never has.
    await page.setViewportSize({ width: 360, height: 740 });
    await login(page, tenant.ownerEmail);

    await openTransactionHistory(page);
    const document_ = await openInvoiceFromHistory(page, invoice.id);
    await expect(invoiceTitle(page)).toHaveText(`Invoice #${invoice.invoiceNumber}`);

    // ONE COLUMN, STACKED — not the desktop layout shrunk until the money is unreadable.
    const statement = (await document_.getByTestId("invoice-statement").boundingBox())!;
    const summary = (await document_.getByTestId("invoice-summary").boundingBox())!;
    expect(Math.abs(summary.x - statement.x)).toBeLessThan(2);
    // STATE FIRST. An operator who opened an invoice on a phone opened it to find out whether it
    // is paid; the itemisation is what they read next, not what they scroll past.
    expect(summary.y).toBeLessThan(statement.y);

    // NOTHING SCROLLS SIDEWAYS. Not the page, and not the workspace inside it.
    await expectNoDocumentOverflow(page, testInfo);
    const overflow = await document_.evaluate((node) => {
      const shell = node.querySelector(".surface-shell")!;
      return shell.scrollWidth - shell.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);

    // THE TEXT IS NOT SHRUNK TO FORCE THE DESKTOP LAYOUT IN. The money statement reads at the same
    // size it reads at on a desk.
    const fontSize = await invoiceStatement(page)
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(13);

    // AND THE ACTIONS ARE STILL REACHABLE, at a size a thumb can hit.
    for (const action of ["invoice-print-invoice", "invoice-print-receipt"]) {
      const control = document_.getByTestId(action);
      await control.scrollIntoViewIfNeeded();
      await expectCriticalTarget(control);
    }
    // Including the close, which is how the operator gets out.
    await expectCriticalTarget(document_.locator("[data-surface-close]"));
    await closeInvoice(page);
    await expect(page.getByTestId("modal")).toContainText("Transactions");
  });

test("@responsive the Invoice workspace is usable on a real handset and tablet",
  async ({ page, request, tenant }, testInfo) => {
    const appointment = await completeAppointment(request, tenant);
    const invoice = await settledInvoice(request, appointment.id);
    await login(page, tenant.ownerEmail);
    // The `@responsive` tag also matches the ungrepped desktop project, and a 44px TOUCH floor
    // is a claim about a finger. A mouse pointer is measured by the other three tests in this
    // file; this one is about the device projects.
    const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    test.skip(!coarse, "touch-target assertions belong to the coarse-pointer projects");

    await openTransactionHistory(page);
    const document_ = await openInvoiceFromHistory(page, invoice.id);

    await expect(invoiceTitle(page)).toHaveText(`Invoice #${invoice.invoiceNumber}`);
    // The financial hierarchy survives the width: what it came to, what settled it, what is left.
    await expect(invoiceStatement(page)).toContainText("Invoice total");
    await expect(document_.getByTestId("invoice-summary-balance")).toContainText("Balance");
    await expect(document_.getByTestId("invoice-state-title")).toBeVisible();
    await expectNoDocumentOverflow(page, testInfo);

    // Every control the operator needs, at a real touch target on a real device.
    await document_.getByTestId("invoice-print-invoice").scrollIntoViewIfNeeded();
    await expectCriticalTarget(document_.getByTestId("invoice-print-invoice"));
    await expectCriticalTarget(document_.locator("[data-surface-close]"));
  });
