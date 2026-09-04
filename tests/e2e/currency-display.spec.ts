import { test, expect, login, completeAppointment } from "./fixtures/tenant.js";
import type { TenantFixture } from "./fixtures/tenant.js";
import { openCheckout } from "./helpers/checkout.js";
import { observePrinting, clearPrintRoots } from "./helpers/print.js";
import type { APIRequestContext, Locator } from "@playwright/test";

/**
 * ONE CURRENCY PRESENTATION CONTRACT, END TO END.
 *
 * `money()` in the web client built an `Intl.NumberFormat` without pinning the fraction digits, so
 * `Intl` applied CLDR's DISPLAY convention rather than the exponent the money model actually uses.
 * For the fifteen supported codes in `currenciesWithoutMinorUnitDisplay` that convention is NO
 * DECIMALS, so the browser rounded to whole units while the domain and the mobile app — which both
 * pin two — did not. The verified symptom: 9999 minor units read "COP 100" on the web and
 * "COP 99.99" on a phone, on a document a client pays against.
 *
 * The full matrix — USD, all fifteen exceptions, a negative, zero and every figure of a
 * mixed-payment invoice, character for character against the domain's own `formatMinor` — is unit
 * work and lives in `tests/domain/web-money-parity.test.mjs`, which also holds the drift guard.
 * THIS spec is the wiring: a workspace really billing in COP, a real invoice, the real endpoint,
 * and the three places a client can be shown the figures.
 *
 * NO ARITHMETIC CHANGED. Every figure below is the server's own integer minor units; all that was
 * ever wrong is how many of them the browser wrote down.
 */

/**
 * U+00A0, which is what `Intl` puts between a bare currency code and the number.
 *
 * Spelled as an escape rather than typed, because a plain space here would make every "character
 * for character" assertion below quietly wrong in a way no diff shows.
 */
const NB = "\u00A0";

/** Every money value must be written to the hundredth. This is the whole contract, as a shape. */
const TWO_DECIMALS = /^-?COP\u00A0[\d,]+\.\d{2}$/u;

async function readBusiness(api: APIRequestContext) {
  const me = await api.get("/api/me");
  expect(me.ok(), await me.text()).toBeTruthy();
  return (await me.json()).business as { name: string; timezone: string; locationVersion: number };
}

/**
 * Switches the workspace to Colombian pesos, and hands the fixture the version that move produced.
 *
 * Every write that touches the location's booking inputs bumps `locationVersion`, and the fixture
 * captured its copy before this ran — so a booking made afterwards with the stale number is refused
 * with `STALE_LOCATION_SETTINGS` rather than tested.
 */
async function billInColombianPesos(api: APIRequestContext, tenant: TenantFixture): Promise<void> {
  const business = await readBusiness(api);
  // `PUT /api/business/settings` is a merge, but these five are required on every call.
  const saved = await api.put("/api/business/settings", {
    data: {
      name: business.name, timezone: business.timezone, currency: "COP",
      taxRateBasisPoints: 825, reminderLeadMinutes: 1440,
      locationVersion: business.locationVersion
    }
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  tenant.locationVersion = (await readBusiness(api)).locationVersion;
}

/** Every money cell of the rendered statement, as `label | value`, in the order it is drawn. */
async function moneyCells(host: Locator): Promise<string[]> {
  const receipt = host.locator(".receipt");
  await expect(receipt).toHaveCount(1);
  return receipt.evaluate((node) =>
    [...node.children]
      .filter((row) => row.tagName === "DIV")
      .map((row) => {
        const label = row.querySelector("span")?.textContent?.trim() ?? "";
        const value = row.querySelector("strong")?.textContent ?? "";
        return `${label} | ${value}`;
      })
  );
}

test("a workspace billing in a CLDR zero-decimal currency keeps its minor units everywhere",
  async ({ page, request, tenant }) => {
    await observePrinting(page);
    await billInColombianPesos(request, tenant);

    // An 85.00 groom, 5.00 off, 8.25% tax on what is left and a 15.00 tip: 8500 - 500 + 660 + 1500
    // = 10160 minor units, settled by TWO payments so the statement carries a mixed settlement.
    const appointment = await completeAppointment(request, tenant);
    const raised = await request.post(`/api/appointments/${appointment.id}/checkout`, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { discountMinor: 500, discountType: "manual", tipMinor: 1500 }
    });
    expect(raised.ok(), await raised.text()).toBeTruthy();
    const invoice = await raised.json() as { id: string; invoiceNumber: number };
    for (const [amountMinor, expectedBalanceMinor] of [[4000, 10_160], [6160, 6160]]) {
      const paid = await request.post(`/api/invoices/${invoice.id}/payments`, {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        data: { amountMinor, expectedBalanceMinor, method: "cash" }
      });
      expect(paid.ok(), await paid.text()).toBeTruthy();
    }

    await login(page, tenant.ownerEmail);

    // ---- Host 1: the receipt modal, off the client's own transaction history ----------------
    await page.getByTestId("nav-customers").click();
    const customer = page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" });
    await customer.getByTestId("client-row-actions").click();
    await customer.getByTestId("client-appointment-history").click();
    const modal = page.getByTestId("modal");
    await modal.getByRole("button", { name: "Receipt" }).click();
    await expect(page.locator("#modal-title")).toHaveText(`Receipt #${invoice.invoiceNumber}`);

    // CHARACTER FOR CHARACTER. Unpinned, `Intl` wrote "COP 85", "COP 7" and "COP 102" for three of
    // these — the tax and the total off by the subunit the invoice is actually stored in.
    const inModal = await moneyCells(modal);
    expect(inModal).toContain(`Subtotal | COP${NB}85.00`);
    expect(inModal).toContain(`Discount | -COP${NB}5.00`);
    expect(inModal).toContain(`Tax | COP${NB}6.60`);
    expect(inModal).toContain(`Tip | COP${NB}15.00`);
    expect(inModal).toContain(`Total | COP${NB}101.60`);
    expect(inModal).toContain(`Balance | COP${NB}0.00`);
    // Both halves of the mixed settlement, and each written the same way.
    expect(inModal).toContain(`Cash · recorded | COP${NB}40.00`);
    expect(inModal).toContain(`Cash · recorded | COP${NB}61.60`);
    // And NOT ONE CELL rounded to a whole unit — including the line items, whose labels this spec
    // does not otherwise assert.
    for (const cell of inModal) {
      expect(cell.split(" | ")[1], cell).toMatch(TWO_DECIMALS);
    }
    await modal.getByRole("button", { name: "Cancel" }).click();

    // ---- Hosts 2 and 3: the settled Check Out panel and the printed document ----------------
    await page.getByTestId("nav-calendar").click();
    await page.waitForLoadState("networkidle");
    const surface = await openCheckout(page, appointment.id);
    await expect(page.getByTestId("checkout-balance")).toHaveText(`Balance COP${NB}0.00`);
    expect(await moneyCells(surface)).toEqual(inModal);

    await surface.getByTestId("checkout-print-receipt").click();
    const printed = await moneyCells(page.locator(".print-root"));
    expect(printed).toEqual(inModal);
    await clearPrintRoots(page);
  });

test("the Business settings currency preview reads the way this workspace's prices will read",
  async ({ page, request, tenant }) => {
    await billInColombianPesos(request, tenant);
    await login(page, tenant.ownerEmail);
    await page.getByTestId("nav-settings").click();
    await page.locator('[data-settings-category="business"]').click();

    // The line is a PROMISE ABOUT HOW PRICES WILL READ, so it has to be made by the formatter that
    // will read them. It used to be built by an independent `Intl` call and claimed
    // "Prices read COP 1,235." for a workspace whose invoices go on saying COP 1,234.56.
    await expect(page.getByTestId("business-currency-sample"))
      .toHaveText(`Prices read COP${NB}1,234.56.`);
  });
