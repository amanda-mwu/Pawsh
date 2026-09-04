import { request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { test, expect, login, createTenant, completeAppointment } from "./fixtures/tenant.js";
import { openAdjustment, checkoutSurface } from "./helpers/checkout.js";
import type { Page } from "@playwright/test";

/**
 * TWO BUSINESSES, ONE TAB — the cross-tenant cache leak, driven the way it actually happened.
 *
 * A browser tab outlives a session. `settleUnauthenticated` used to clear `state.me`, the location
 * list, three calendar preferences and the dialogs, and NOTHING ELSE: every module cache in
 * `public/app.js` survived sign-out. Sign in as a second salon on the same front-desk machine and
 * `ensureCheckoutPaymentOptions` short-circuited on `checkoutOptions.data` — a cache filled for
 * somebody else — so the new operator was shown the previous salon's payment methods and its
 * configured discounts. THAT IS TENANT DATA EXPOSURE, not a stale screen.
 *
 * IN THE SAME TAB AND THE SAME CONTEXT IS THE WHOLE POINT. `login()` in the fixtures navigates,
 * and a navigation throws the JS heap away, which is exactly why every existing spec passed over
 * this. So the second sign-in here goes through the account menu's Sign out and the form that is
 * left on screen, with no `goto` and no `reload` between them — the one route between two
 * businesses that keeps the module alive. (Switching workspace from the profile picker is the
 * other, and it does a full `location.reload()`, which is why it was never affected.)
 *
 * The payment/discount cache is asserted because it is the verified example. The client directory
 * is asserted alongside it because `state` was leaking too, and a leak of clients is a leak of
 * names, phone numbers and addresses.
 */

const label = (side: string, thing: string): string => `${side} ${thing}`;

/** Rows that exist in one business and must never be legible from the other. */
async function configure(api: APIRequestContext, side: string): Promise<void> {
  const method = await api.post("/api/settings/payment-methods", {
    data: { name: label(side, "Salon Tap"), settlementType: "external_card", enabled: true }
  });
  expect(method.ok(), await method.text()).toBeTruthy();
  const discount = await api.post("/api/settings/discounts", {
    data: {
      name: label(side, "Loyalty"), kind: "amount", amountMinor: 500, applyScope: "per_appointment"
    }
  });
  expect(discount.ok(), await discount.text()).toBeTruthy();
  const customer = await api.post("/api/customers", {
    data: { firstName: side, lastName: "OnlyClient", phone: "626-555-0199" }
  });
  expect(customer.ok(), await customer.text()).toBeTruthy();
}

/**
 * Opens Check Out from the appointment itself rather than the calendar's action menu.
 *
 * The menu is a two-step interaction over a card the calendar redraws as its own reads land, and
 * this spec cannot reload the page to settle it - a reload is precisely the thing that would clear
 * the caches under test. Opening the visit and pressing Take Payment is one click on the card and
 * one on a surface the calendar does not redraw.
 */
async function takePayment(page: Page, appointmentId: string) {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await page.locator(`[data-appointment-id="${appointmentId}"]`).first().click();
  await expect(page.getByTestId("appointment-detail-surface")).toBeVisible();
  await page.getByTestId("appointment-take-payment").click();
  const surface = checkoutSurface(page);
  await expect(surface).toBeVisible();
  return surface;
}

/** Dismisses the appointment stack, top level first, so the header is reachable again. */
async function closeSurfaces(page: Page): Promise<void> {
  for (const id of ["checkout-surface", "appointment-detail-surface"]) {
    const surface = page.getByTestId(id);
    if (!(await surface.isVisible())) continue;
    await surface.locator("[data-surface-close]").click();
    await expect(surface).toBeHidden();
  }
}

/** Signs out through the account menu — no navigation, so the module and its caches stay alive. */
async function signOutInPlace(page: Page): Promise<void> {
  await page.getByTestId("account-trigger").click();
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("auth-form")).toBeVisible();
  await expect(page.locator("#app-view")).toBeHidden();
}

/**
 * Signs in on the form that sign-out left on screen.
 *
 * The form is ALREADY in its sign-in half: `state.login` is which side of the auth screen is
 * showing rather than anything a business owns, so the reset deliberately keeps it. Somebody who
 * just signed out being flipped back to "Create your salon" would be a new defect.
 */
async function signInInPlace(page: Page, email: string, secret: string): Promise<void> {
  await expect(page.getByTestId("auth-submit")).toHaveText("Sign in");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(secret);
  const response = page.waitForResponse((incoming) =>
    incoming.url().endsWith("/api/auth/login") && incoming.request().method() === "POST");
  await page.getByTestId("auth-submit").click();
  expect((await response).status()).toBe(200);
  await expect(page.locator("#app-view")).toBeVisible();
}

test("a second business in the same tab inherits none of the first one's cached data", async ({
  page,
  request,
  tenant
}) => {
  const betaApi = await playwrightRequest.newContext({
    baseURL: process.env.PAWSH_E2E_BASE_URL ?? "http://127.0.0.1:3000"
  });
  const beta = await createTenant(betaApi, "cache-isolation-beta");
  await configure(request, "Alpha");
  await configure(betaApi, "Beta");
  const alphaVisit = await completeAppointment(request, tenant);
  const betaVisit = await completeAppointment(betaApi, beta);

  // ---- Business A fills the caches --------------------------------------------------------
  await login(page, tenant.ownerEmail);
  const alphaCheckout = await takePayment(page, alphaVisit.id);
  await expect(alphaCheckout.getByTestId("field-method")).toContainText("Alpha Salon Tap");
  // The configured rows live behind "Apply coupon or discount"; the "Set discount" disclosure is
  // the manual amount field and reads nothing from the cache.
  await expect(await openAdjustment(page, "coupon")).toContainText("Alpha Loyalty");
  await closeSurfaces(page);

  // ---- The same tab becomes Business B ----------------------------------------------------
  await signOutInPlace(page);
  // Counted from here: a cache that survived would let the second session render without ever
  // asking the server, so "it fetched again" is half of what this spec is asserting.
  const paymentOptionReads: string[] = [];
  page.on("request", (outgoing) => {
    if (new URL(outgoing.url()).pathname === "/api/checkout/payment-options") {
      paymentOptionReads.push(outgoing.url());
    }
  });
  await signInInPlace(page, beta.ownerEmail, beta.password);

  const betaCheckout = await takePayment(page, betaVisit.id);

  // THE ASSERTION. Business B's own methods, and not one character of Business A's.
  await expect(betaCheckout.getByTestId("field-method")).toContainText("Beta Salon Tap");
  await expect(betaCheckout.getByTestId("field-method")).not.toContainText("Alpha Salon Tap");
  const discounts = await openAdjustment(page, "coupon");
  await expect(discounts).toContainText("Beta Loyalty");
  await expect(discounts).not.toContainText("Alpha Loyalty");
  // Fresh rows, not remembered ones.
  expect(paymentOptionReads.length).toBeGreaterThan(0);

  await closeSurfaces(page);

  // The client directory leaked the same way, and a leak of clients is a leak of names and phone
  // numbers. `state` is rebuilt wholesale on the same reset, so this is the other half of it.
  await page.getByTestId("nav-customers").click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("customer-card").filter({ hasText: "Beta OnlyClient" }))
    .toHaveCount(1);
  await expect(page.getByTestId("customer-card").filter({ hasText: "Alpha OnlyClient" }))
    .toHaveCount(0);
  await expect(page.locator("#customers")).not.toContainText("Alpha OnlyClient");

  await betaApi.dispose();
});
