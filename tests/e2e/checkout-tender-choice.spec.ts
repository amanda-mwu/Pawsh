import { test, expect, login, completeAppointment } from "./fixtures/tenant.js";
import { checkoutSurface, chooseMethod } from "./helpers/checkout.js";
import { closeInvoice, invoiceSurface } from "./helpers/invoice.js";
import { voidRecord } from "./helpers/void-payment.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * NOTHING IS TENDERED UNTIL SOMEBODY TENDERS IT, AND CHECK OUT STATES ITS MONEY ONCE.
 *
 * ─── THE TWO DEFECTS, AS THE OWNER MET THEM ─────────────────────────────────────────────────
 *
 * She pressed Take Payment on a visit whose invoice a void had reopened, and a full CASH payment
 * landed against it without her ever being shown a tender-method choice.
 *
 * The payment form was rendering — the amount field, the four salon methods and the submit were
 * all on screen and in the viewport — and opening the surface sent no request at all. The surface
 * had simply already answered the question: the first radio was checked (`index===0`, which is
 * Cash) and the amount was pre-filled with the whole balance, so Check Out opened holding a
 * complete, valid, submittable cash payment. The appointment footer's `Take Payment` sits at
 * x=1136,y=672 and Check Out's `Take payment` at x=1135,y=672 — same size, same slot, one pixel
 * and one capital letter apart. A second press of what looks like the same button settled the
 * invoice.
 *
 * On a settled invoice the bill column also drew `Subtotal / Discount / Tax / Tip / Total` off the
 * invoice while the rail drew the shared statement beside it: the same five figures, twice, in two
 * shapes.
 *
 * ─── WHY THESE ARE BROWSER TESTS ────────────────────────────────────────────────────────────
 *
 * What the markup SAYS in each mode is `tests/ui/checkout-tender-and-statement.test.ts`, and it is
 * held there deterministically. Three things cannot be asserted there and are why this walk
 * exists:
 *
 *   THE REQUEST IS NOT SENT. The claim is about an absence — that pressing Take Payment, and then
 *       pressing the primary under it, transmits no `POST /api/invoices/:id/payments`. Only a real
 *       page can be watched for a request it did not make.
 *   THE SERVER AGREES. `open`, `$101.60`, `paid` are the SERVER's answers to a real void and a
 *       real tender, read back off the receipt endpoint rather than off the screen.
 *   THE OPERATOR CAN STILL FINISH. A surface that refuses to record anything would pass every
 *       assertion about not recording, so each walk ends by choosing a method and settling.
 *
 * NOT IN SCOPE and deliberately untouched: the settlement model, the two Receipt gates, tender
 * composition and refund attribution. That the shared statement agrees cell-for-cell across its
 * three hosts is `tests/e2e/ticket-surface.spec.ts`.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");
const takePayment = (page: Page): Locator => detail(page).getByTestId("appointment-take-payment");

async function raiseInvoice(api: APIRequestContext, appointmentId: string): Promise<{
  id: string; invoiceNumber: string; balanceMinor: number;
}> {
  const response = await api.post(`/api/appointments/${appointmentId}/checkout`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { discountMinor: 500, discountType: "manual", tipMinor: 1500 }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { id: string; invoiceNumber: string; balanceMinor: number };
}

async function settleInvoice(
  api: APIRequestContext, invoiceId: string, balanceMinor: number
): Promise<void> {
  const response = await api.post(`/api/invoices/${invoiceId}/payments`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { amountMinor: balanceMinor, expectedBalanceMinor: balanceMinor, method: "cash" }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** What the server says, which is the only authority on whether anything was recorded. */
async function invoiceState(api: APIRequestContext, invoiceId: string): Promise<{
  status: string; balanceMinor: number; recorded: string[];
}> {
  const response = await api.get(`/api/invoices/${invoiceId}/receipt`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as {
    invoice: { status: string; balanceMinor: number };
    payments: { method: string; status: string }[];
  };
  return {
    status: payload.invoice.status,
    balanceMinor: payload.invoice.balanceMinor,
    recorded: payload.payments.filter((p) => p.status === "recorded").map((p) => p.method)
  };
}

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

/** Settles the invoice, then voids the payment — the state the owner was in. */
async function reopenedByVoid(page: Page, appointmentId: string): Promise<void> {
  await openDetail(page, appointmentId);
  await detail(page).getByTestId("appointment-invoice").click();
  await expect(invoiceSurface(page)).toBeVisible();
  await voidRecord(
    page,
    invoiceSurface(page).getByRole("button", { name: "Void record" }),
    "Cash was never handed over"
  );
  await closeInvoice(page);
  await expect(detail(page)).toBeVisible();
}

const dollars = (minor: number): string => `$${(minor / 100).toFixed(2)}`;

test("Take Payment opens the checkout and records nothing until a method is chosen and submitted",
  async ({ page, request, tenant }) => {
    const appointment = await completeAppointment(request, tenant);
    const invoice = await raiseInvoice(request, appointment.id);
    await settleInvoice(request, invoice.id, invoice.balanceMinor);
    const due = dollars(invoice.balanceMinor);

    await login(page, tenant.ownerEmail);
    await reopenedByVoid(page, appointment.id);
    expect(await invoiceState(request, invoice.id))
      .toEqual({ status: "open", balanceMinor: invoice.balanceMinor, recorded: [] });

    // EVERY tender this page attempts, from before the surface is even opened. The assertions
    // below are about which of these are absent.
    const tenders: string[] = [];
    page.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST"
        && /\/api\/invoices\/[^/]+\/payments$/u.test(new URL(outgoing.url()).pathname)
      ) tenders.push(outgoing.postData() ?? "");
    });

    // ── 1. OPENING THE SURFACE TENDERS NOTHING ────────────────────────────────────────────────
    await takePayment(page).click();
    await expect(checkoutSurface(page)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(tenders, "opening Check Out must not record a payment").toEqual([]);

    // ── 2. AND IT HAS CHOSEN NOTHING ON THE OPERATOR'S BEHALF ─────────────────────────────────
    // The defect exactly: this used to be Cash, checked, with the balance already in the field.
    const methods = page.getByTestId("field-method").locator('input[name="method"]');
    await expect(methods).toHaveCount(4);
    await expect(methods.locator(":checked")).toHaveCount(0);
    // The amount is still offered, because a pre-filled figure cannot become a tender nobody chose.
    await expect(page.getByTestId("field-pay")).toHaveValue((invoice.balanceMinor / 100).toFixed(2));
    await expect(page.getByTestId("checkout-balance")).toContainText(`Balance ${due}`);

    // ── 3. PRESSING THE PRIMARY WITH NOTHING CHOSEN ASKS, RATHER THAN TENDERING ───────────────
    // This is the press that used to settle the invoice as cash.
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByTestId("checkout-error")).toHaveText("Choose a payment method.");
    expect(tenders, "a submit with no method chosen must not record a payment").toEqual([]);
    // The server has not moved.
    expect(await invoiceState(request, invoice.id))
      .toEqual({ status: "open", balanceMinor: invoice.balanceMinor, recorded: [] });
    // The surface is still collecting, not settled.
    await expect(checkoutSurface(page).getByTestId("receipt")).toHaveCount(0);
    await expect(page.getByTestId("checkout-submit")).toBeVisible();

    // ── 4. AND THE OPERATOR CAN STILL FINISH ─────────────────────────────────────────────────
    // Without this the three assertions above would be satisfied by a surface that simply refuses.
    await chooseMethod(page, "Cash");
    await page.getByTestId("checkout-submit").click();
    await expect(checkoutSurface(page).getByTestId("receipt")).toContainText("Balance$0.00");
    expect(tenders, "exactly one tender, the one that was chosen").toHaveLength(1);
    expect(await invoiceState(request, invoice.id))
      .toEqual({ status: "paid", balanceMinor: 0, recorded: ["cash"] });
  });

test("the methods offered are the ones this workspace supports, and a workspace with no card terminal is offered none",
  async ({ page, request, tenant }) => {
    const appointment = await completeAppointment(request, tenant);

    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);
    await takePayment(page).click();
    await expect(checkoutSurface(page)).toBeVisible();

    // The salon's own four, by the names the salon configured, from
    // `GET /api/checkout/payment-options`.
    const configured = await request.get("/api/checkout/payment-options");
    expect(configured.ok(), await configured.text()).toBeTruthy();
    const options = (await configured.json()) as { paymentMethods: { id: string; name: string }[] };
    const offered = page.getByTestId("field-method");
    for (const method of options.paymentMethods) {
      await expect(offered.locator(`input[value="${method.id}"]`)).toHaveCount(1);
    }
    await expect(offered.locator('input[name="method"]'))
      .toHaveCount(options.paymentMethods.length);

    // NO SQUARE CONNECTION IN THIS WORKSPACE, so there is no card terminal to offer. The point is
    // not only that it is absent — it is that its absence cannot quietly resolve to Cash, because
    // nothing is chosen for the operator at all.
    const terminal = await request.get("/api/checkout/terminal");
    expect(((await terminal.json()) as { available: boolean }).available).toBe(false);
    await expect(offered).not.toContainText("Card terminal");
    await expect(offered.locator(":checked")).toHaveCount(0);

    // Nor is credit offered to a client who has none.
    await expect(offered).not.toContainText("Client credit");

    // Leaving without choosing costs nothing and records nothing.
    const tenders: string[] = [];
    page.on("request", (outgoing) => {
      if (outgoing.method() === "POST" && /\/payments$/u.test(new URL(outgoing.url()).pathname)) {
        tenders.push(outgoing.url());
      }
    });
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByTestId("checkout-error")).toHaveText("Choose a payment method.");
    expect(tenders).toEqual([]);
  });

test("Check Out states the money once, and carries its footer controls in every mode",
  async ({ page, request, tenant }) => {
    /** Every money figure inside one region of the surface. */
    const figuresIn = async (selector: string): Promise<string[]> =>
      checkoutSurface(page).locator(selector).evaluate((node) =>
        [...((node.textContent || "").matchAll(/\$\d[\d,]*\.\d{2}/gu))].map((m) => m[0]));

    const footControls = async (): Promise<string[]> =>
      checkoutSurface(page).locator(".surface-foot button").evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-testid") ?? ""));

    const appointment = await completeAppointment(request, tenant);
    await login(page, tenant.ownerEmail);

    // ── BUILD: no invoice yet. The bill column is the only statement there is. ────────────────
    await openDetail(page, appointment.id);
    await takePayment(page).click();
    await expect(checkoutSurface(page)).toBeVisible();
    expect(await figuresIn(".checkout-bill")).toContain("$85.00");
    await expect(checkoutSurface(page).getByTestId("receipt")).toHaveCount(0);
    expect(await footControls()).toEqual(["checkout-ticket", "checkout-submit"]);

    // ── COLLECT: an invoice with a balance. Still the only statement; the rail is the form. ───
    const invoice = await raiseInvoice(request, appointment.id);
    await page.reload();
    await openDetail(page, appointment.id);
    await takePayment(page).click();
    await expect(checkoutSurface(page)).toBeVisible();
    const owed = dollars(invoice.balanceMinor);
    expect(await figuresIn(".checkout-bill")).toContain(owed);
    await expect(checkoutSurface(page).getByTestId("receipt")).toHaveCount(0);
    await expect(page.getByTestId("checkout-frozen")).toContainText("already raised");
    expect(await footControls())
      .toEqual(["checkout-print-invoice", "checkout-ticket", "checkout-submit"]);

    // ── SETTLED: the rail states it in full, and the bill column states none of it. ───────────
    await chooseMethod(page, "Cash");
    await page.getByTestId("checkout-submit").click();
    await expect(checkoutSurface(page).getByTestId("receipt")).toContainText("Balance$0.00");

    // THE DEFECT EXACTLY. The bill column used to carry Subtotal/Discount/Tax/Tip/Total here,
    // beside the rail's full statement of the same five figures.
    expect(await figuresIn(".checkout-bill"),
      "the bill column must state no money once the rail states it in full").toEqual([]);
    // ...and it no longer claims the payment is open on an invoice whose payment is closed.
    await expect(page.getByTestId("checkout-frozen")).toHaveCount(0);
    // Exactly one statement on the surface, and the invoice total is written once in it.
    await expect(checkoutSurface(page).getByTestId("receipt")).toHaveCount(1);
    // THE PAYMENT RECORDS ARE NOT A SECOND STATEMENT OF THE BILL. A tender that settled the
    // invoice in full is the same figure as the invoice total by arithmetic rather than by
    // duplication - "what it came to" and "what was handed over" are two facts that happen to
    // agree - so the rows recording what was tendered are excluded before the calculation is
    // counted. Excluding them is also what makes this assertion fail loudly if the bill column's
    // list ever comes back: that list is part of the calculation, not part of the record.
    const calculation = await checkoutSurface(page).locator(".surface-body").evaluate((node) => {
      const copy = node.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[data-testid="receipt-payment"],[data-testid="receipt-refund"]')
        .forEach((row) => { row.remove(); });
      return [...((copy.textContent || "").matchAll(/\$\d[\d,]*\.\d{2}/gu))].map((m) => m[0]);
    });
    expect(calculation.filter((figure) => figure === owed),
      "the invoice total is stated once on this surface").toHaveLength(1);
    await expect(checkoutSurface(page).getByTestId("receipt-invoice-total")).toHaveCount(1);
    // The visit itself is still here — the column lost its money, not its content.
    await expect(checkoutSurface(page).locator(".checkout-bill")).toContainText("Full Groom");
    await expect(checkoutSurface(page).getByTestId("checkout-lifecycle")).toBeVisible();

    expect(await footControls()).toEqual([
      "checkout-print-invoice", "checkout-print-receipt", "checkout-ticket", "checkout-done"
    ]);
    // Every one of them actually laid out, not merely present in the markup.
    for (const control of await footControls()) {
      await expect(checkoutSurface(page).getByTestId(control)).toBeVisible();
    }
  });

test("nothing empty sits between the body and the footer, in any mode",
  async ({ page, request, tenant }) => {
    /**
     * THE OTHER HALF OF WHAT THE OWNER SAW: "the footer area appears empty".
     *
     * Check Out's shell is `grid-template-rows:auto minmax(0,1fr) auto` — three rows — and it was
     * being handed FOUR children, because the surface carries a bare `<p class="error">` between
     * its body and its footer and `.error` has a global `min-height:19px` so a message arriving
     * does not shift the form under it. The footer therefore landed in an implicit fourth row with
     * a permanently blank full-width band above it: 42px, at every viewport measured from 390x844
     * to 1440x900, immediately over the action row. The Invoice workspace has no such child and
     * no such band.
     *
     * The claim asserted here is geometric and it is the one that matters to a reader: THE FOOTER
     * BEGINS WHERE THE BODY ENDS. It is asserted in all three modes because the band was in all
     * three, and it is asserted at two viewport widths because the shell's rows are not
     * responsive but the footer's own layout is.
     *
     * It does not assert the error is absent — it must not be. A real message has to take its
     * space back, which the last leg checks by putting one on screen.
     */
    const gap = async (): Promise<number> =>
      checkoutSurface(page).evaluate((root) => {
        const body = root.querySelector(".surface-body")!.getBoundingClientRect();
        const foot = root.querySelector(".surface-foot")!.getBoundingClientRect();
        return Math.round(foot.top - body.bottom);
      });

    const appointment = await completeAppointment(request, tenant);
    await login(page, tenant.ownerEmail);

    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });

      // BUILD
      await openDetail(page, appointment.id);
      await takePayment(page).click();
      await expect(checkoutSurface(page)).toBeVisible();
      expect(await gap(), `build @ ${width}`).toBe(0);

      // The error takes its space back the moment there is something to read, and the footer is
      // still the footer: it does not move, because the body absorbs the row.
      const footBefore = await checkoutSurface(page)
        .locator(".surface-foot").evaluate((n) => Math.round(n.getBoundingClientRect().top));
      await page.getByTestId("checkout-submit").click();
      await expect(page.getByTestId("checkout-error")).toHaveText("Choose a payment method.");
      await expect(page.getByTestId("checkout-error")).toBeVisible();
      const footAfter = await checkoutSurface(page)
        .locator(".surface-foot").evaluate((n) => Math.round(n.getBoundingClientRect().top));
      expect(footAfter, `the footer must not move when an error arrives @ ${width}`)
        .toBe(footBefore);

      await checkoutSurface(page).locator("[data-surface-close]").click();
      await expect(checkoutSurface(page)).toBeHidden();
      await detail(page).locator("[data-surface-close]").click();
      await expect(detail(page)).toBeHidden();
    }

    // COLLECT and SETTLED, at the width the owner's screenshot was taken near.
    await page.setViewportSize({ width: 1440, height: 900 });
    const invoice = await raiseInvoice(request, appointment.id);
    await page.reload();
    await openDetail(page, appointment.id);
    await takePayment(page).click();
    await expect(checkoutSurface(page)).toBeVisible();
    expect(await gap(), "collect").toBe(0);

    await chooseMethod(page, "Cash");
    await page.getByTestId("checkout-submit").click();
    await expect(checkoutSurface(page).getByTestId("receipt")).toContainText("Balance$0.00");
    expect(await gap(), "settled").toBe(0);
    expect(invoice.balanceMinor).toBeGreaterThan(0);
  });
