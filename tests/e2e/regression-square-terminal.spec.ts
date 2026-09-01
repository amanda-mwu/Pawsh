import { test, expect, login, completeAppointment, appointmentAction } from "./fixtures/tenant.js";
import type { Page } from "@playwright/test";
import {
  routeSquareIntegration, routeCheckoutTerminal, stubDevice, pairedCode,
  terminalCheckoutBody, fulfillJson, type SquareIntegrationState
} from "./helpers/square.js";

/**
 * Square terminal pairing and the capture modal, driven entirely through Pawsh's own API surface.
 *
 * Square itself is never reached: page.route answers Pawsh's integration endpoints in the shapes
 * presentDevice and presentCheckout produce, so these specs exercise the client wiring without a
 * Square account, a sandbox token or any outbound request. See tests/e2e/helpers/square.ts.
 */

async function openTaxPaymentsProcessors(page: Page): Promise<void> {
  await page.getByTestId("nav-settings").click();
  await page.locator('[data-settings-category="tax-payments"]').click();
  await page.getByTestId("taxpay-tab-processors").click();
  await expect(page.getByTestId("square-status")).toHaveText("Connected");
}

test("@regression-square-terminal drawer terminal controls act on the device they name", async ({ page, request, tenant }) => {
  // A real Square card processor row, so the Terminal setting button and the drawer's Square
  // branch are reached the way the screen actually reaches them.
  const processor = await request.post("/api/settings/card-processors", {
    data: { provider: "square", locationLabel: "Front desk" }
  });
  expect(processor.ok(), await processor.text()).toBeTruthy();

  const device = stubDevice({ id: "11111111-1111-4111-8111-111111111111", label: "Front desk reader" });
  const state: SquareIntegrationState = { devices: [device] };
  await routeSquareIntegration(page, () => state);

  // Every write these buttons are supposed to make, recorded rather than assumed.
  const issued: string[] = [];
  const checked: string[] = [];
  await page.route("**/api/integrations/square/devices/*/code", async (route) => {
    issued.push(new URL(route.request().url()).pathname);
    state.devices = [pairedCode(device, "ABCD-EFGH")];
    await fulfillJson(route, state.devices[0]);
  });
  await page.route("**/api/integrations/square/devices/*/refresh", async (route) => {
    checked.push(new URL(route.request().url()).pathname);
    state.devices = [{ ...device, pairingStatus: "paired", pairingCode: null, pairedAt: new Date().toISOString() }];
    await fulfillJson(route, state.devices[0]);
  });

  await login(page, tenant.ownerEmail);
  await openTaxPaymentsProcessors(page);

  await page.getByRole("button", { name: "Terminal setting for Square" }).click();
  const drawer = page.getByTestId("terminal-drawer");
  await expect(drawer).toBeVisible();
  // A connected Square shows the real paired-device list, not the inventory table.
  await expect(drawer.getByTestId("square-device-list")).toBeVisible();
  await expect(drawer.getByText("Front desk reader")).toBeVisible();

  // The regression: these controls were rendered into the drawer but bound only on the settings
  // panel, so clicking one did nothing at all - no request, no toast, no change on screen.
  await drawer.getByRole("button", { name: "Get a code" }).click();
  await expect.poll(() => issued.length, { message: "Get a code issued no request" }).toBe(1);
  expect(issued[0]).toContain(`/api/integrations/square/devices/${device.id}/code`);
  // The observable consequence, not just the request: the code a person has to type is on screen.
  await expect(drawer.getByTestId(`square-code-${device.id}`)).toContainText("ABCD-EFGH");

  await drawer.getByRole("button", { name: "Check pairing" }).click();
  await expect.poll(() => checked.length, { message: "Check pairing issued no request" }).toBe(1);
  await expect(drawer.getByText("Ready to take payments.")).toBeVisible();
});

/** Drives a completed appointment through checkout on the card terminal, leaving the modal open. */
async function openCaptureModal(
  page: Page,
  tenant: { ownerEmail: string },
  appointmentId: string,
  pollBody: () => Record<string, unknown> | null
) {
  await routeCheckoutTerminal(page, [{ id: "device-stub-0001", label: "Front desk reader" }]);
  await page.route("**/api/invoices/*/terminal-checkouts", async (route) => {
    const invoiceId = new URL(route.request().url()).pathname.split("/")[3] ?? "";
    await fulfillJson(route, terminalCheckoutBody({ invoiceId, status: "pending", squareCheckoutId: "sq-1" }));
  });
  await page.route("**/api/square/terminal-checkouts/*", async (route) => {
    const body = pollBody();
    if (!body) {
      return route.fulfill({
        status: 401, contentType: "application/json", body: JSON.stringify({ error: "Session expired" })
      });
    }
    await fulfillJson(route, body);
  });

  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await (await appointmentAction(page.locator(`[data-appointment-id="${appointmentId}"]`), "appointment-completed")).click();
  await page.getByTestId("field-method").selectOption({ label: "Card terminal" });
  // Choosing the terminal takes the tip controls away and says what the button is about to do.
  await expect(page.getByTestId("checkout-terminal-note")).toBeVisible();
  await expect(page.getByTestId("modal-submit")).toHaveText("Send to terminal");
  await page.getByTestId("modal-submit").click();

  const capture = page.getByTestId("terminal-capture");
  await expect(capture).toBeVisible();
  await expect(page.getByTestId("terminal-capture-status")).toHaveText("Waiting for the customer");
  return capture;
}

test("@regression-square-terminal capture modal refuses a silent dismissal while the card is in flight", async ({ page, request, tenant }) => {
  const appointment = await completeAppointment(request, tenant);
  const inFlight = terminalCheckoutBody({ invoiceId: "x", status: "pending", squareCheckoutId: "sq-1" });
  const capture = await openCaptureModal(page, tenant, appointment.id, () => inFlight);

  // Playwright dismisses an unhandled confirm(), which is the operator answering "no". Escape is
  // the likeliest accidental dismissal and the one that used to lose the payment outright.
  await page.keyboard.press("Escape");
  await expect(capture, "Escape closed a modal watching a live card payment").toBeVisible();
  await expect(page.getByTestId("terminal-capture-status")).toHaveText("Waiting for the customer");

  // The footer Close is guarded by the same question, and answering "no" keeps the payment on screen.
  await page.getByTestId("terminal-capture-close").click();
  await expect(capture).toBeVisible();

  // Saying yes is still allowed: this stops silent loss, it does not trap the operator.
  const asked: string[] = [];
  page.once("dialog", async (dialog) => { asked.push(dialog.message()); await dialog.accept(); });
  await page.getByTestId("terminal-capture-close").click();
  await expect(capture).toBeHidden();
  expect(asked[0]).toContain("still be paying on the terminal");
});

test("@regression-square-terminal a needs-review capture cannot be dismissed without being told", async ({ page, request, tenant }) => {
  const appointment = await completeAppointment(request, tenant);
  let body = terminalCheckoutBody({ invoiceId: "x", status: "pending", squareCheckoutId: "sq-1" });
  const capture = await openCaptureModal(page, tenant, appointment.id, () => body);

  // The reconciler decides this state, and its instruction to fetch a manager exists on no other
  // screen - so it carries the same guard an in-flight payment does.
  body = terminalCheckoutBody({ invoiceId: "x", status: "needs_review", squareCheckoutId: "sq-1" });
  await expect(page.getByTestId("terminal-capture-status")).toHaveText("Needs review");
  await expect(page.getByTestId("terminal-capture-review")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(capture, "Escape closed a capture that needs a manager's review").toBeVisible();

  const asked: string[] = [];
  page.once("dialog", async (dialog) => { asked.push(dialog.message()); await dialog.accept(); });
  await page.getByTestId("terminal-capture-close").click();
  await expect(capture).toBeHidden();
  expect(asked[0]).toContain("needs a manager's review");
});

test("@regression-square-terminal a lapsed session closes the capture modal and stops the poll", async ({ page, request, tenant }) => {
  const appointment = await completeAppointment(request, tenant);
  let alive = true;
  const inFlight = terminalCheckoutBody({ invoiceId: "x", status: "pending", squareCheckoutId: "sq-1" });
  const polls: number[] = [];
  page.on("request", (req) => {
    if (/\/api\/square\/terminal-checkouts\/[^/]+$/.test(new URL(req.url()).pathname)) polls.push(Date.now());
  });
  const capture = await openCaptureModal(page, tenant, appointment.id, () => (alive ? inFlight : null));

  // The session lapses underneath an open modal. Before the fix this dialog stayed on screen, and
  // because showModal() makes the rest of the document inert it covered the login form outright,
  // while the poll went on 401ing every couple of seconds behind it.
  alive = false;
  await expect(capture).toBeHidden();
  await expect(page.getByTestId("auth-form")).toBeVisible();
  await expect(page.locator("#modal")).toBeHidden();

  const settled = polls.length;
  await page.waitForTimeout(6_000);
  expect(polls.length, "the status poll kept running after the session ended").toBe(settled);
});
