import { test, expect, login, createAppointment, createMember, password } from "./fixtures/tenant.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { permissionPresets } from "@pawsh/domain";
import { dragAppointmentToSlot } from "./helpers/calendar.js";

/**
 * A GROOMER'S APPOINTMENTS ARE THEIR OWN, AND THE SCREEN SAYS SO BEFORE THE SERVER HAS TO.
 *
 * `appointments.edit` and the three operations keys now mean "on appointments assigned to ME";
 * `appointments.edit_all_staff` widens that to anybody's. The server refuses a mismatch with 403
 * `NOT_ASSIGNED_TO_YOU`; this walk holds the UI's mirror of that rule in a real browser, with two
 * members each linked to their own employee record:
 *
 *   ON A COLLEAGUE'S VISIT every scoped control is drawn, disabled, and names the key that would
 *       lift it - not the permission the member already holds.
 *   ON THEIR OWN VISIT the same controls are pressable and the work goes through.
 *   ON THE GRID their own card drags and a colleague's does not; a drop onto a colleague's column
 *       is refused on the client, by name, before any request.
 *   BLOCK TIME is scoped the same way: the create dialog offers only themselves, their own block
 *       is editable and movable, a colleague's is read-only with the scope key named.
 *
 * BACKEND-DEPENDENT throughout: the surface reads its own employee id off `GET /api/me`, which
 * the seam contract adds. Until then every member owns nothing and every scoped control is
 * refused - which this file will report, correctly, as a failure.
 */

// The Groomer preset plus the cancel key: a custom role, so that Cancel and No show are DRAWN on
// the card and the surface and the scope alone decides whether they are pressable.
const GROOMER = [...new Set([...permissionPresets.groomer!, "appointments.edit", "calendar.blocks_create", "calendar.blocks_edit", "appointments.cancel"])];
const SCOPE = /appointments\.edit_all_staff/u;

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");

async function link(api: APIRequestContext, employeeId: string, membershipId: string): Promise<void> {
  const linked = await api.put(`/api/employees/${employeeId}`, { data: { membershipId } });
  expect(linked.ok(), await linked.text()).toBeTruthy();
}

/** Two groomers, each linked to their own employee, and one appointment for each. */
async function twoGroomers(api: APIRequestContext, tenant: Parameters<typeof createAppointment>[1]) {
  const gabriel = await (await api.post("/api/employees", {
    data: { displayName: "Gabriel Groomer", serviceIds: [tenant.serviceId] }
  })).json() as { id: string };
  await api.put(`/api/employees/${gabriel.id}/working-hours`, { data: { hours: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday, startTime: "08:00", endTime: "18:00"
  })) } });
  const grace = await createMember(api, `grace+${tenant.runId}@pawsh-test.example`, GROOMER);
  const gabe = await createMember(api, `gabriel+${tenant.runId}@pawsh-test.example`, GROOMER);
  await link(api, tenant.employeeId, grace.membershipId);
  await link(api, gabriel.id, gabe.membershipId);
  const graces = await createAppointment(api, tenant, { localStart: `${tenant.anchor}T09:00` });
  const gabriels = await (await api.post("/api/appointments", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {
      locationId: tenant.locationId, customerId: tenant.rockyCustomerId, petId: tenant.rockyPetId,
      employeeId: gabriel.id, serviceIds: [tenant.serviceId], localStart: `${tenant.anchor}T11:00`,
      expectedLocationVersion: tenant.locationVersion
    }
  })).json() as { id: string; version: number };
  return { gabriel, grace, gabe, graces, gabriels };
}

/** Completed, billed and paid in full through the owner's API - the visit as the desk leaves it. */
async function settle(api: APIRequestContext, appointment: { id: string; version: number }): Promise<void> {
  let version = appointment.version;
  for (const status of ["checked_in", "in_service", "completed"]) {
    const moved = await api.post(`/api/appointments/${appointment.id}/transition`, { data: { status, version } });
    expect(moved.ok(), await moved.text()).toBeTruthy();
    version = ((await moved.json()) as { version: number }).version;
  }
  const billed = await api.post(`/api/appointments/${appointment.id}/checkout`, {
    headers: { "Idempotency-Key": crypto.randomUUID() }, data: { discountMinor: 0, discountType: "manual", tipMinor: 0 }
  });
  expect(billed.ok(), await billed.text()).toBeTruthy();
  const invoice = (await billed.json()) as { id: string; balanceMinor: number };
  const paid = await api.post(`/api/invoices/${invoice.id}/payments`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { amountMinor: invoice.balanceMinor, expectedBalanceMinor: invoice.balanceMinor, method: "cash" }
  });
  expect(paid.ok(), await paid.text()).toBeTruthy();
}

async function openCalendar(page: Page): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

test("a groomer sees a colleague's visit refused by scope, with the key named, and their own open",
  async ({ page, request, tenant }) => {
    const { grace, graces, gabriels } = await twoGroomers(request, tenant);
    await login(page, grace.email, password);
    await openCalendar(page);

    // GABRIEL'S VISIT. Drawn, disabled, and each control names the scope key rather than the key
    // Grace already holds.
    await openDetail(page, gabriels.id);
    for (const testid of ["appointment-groomer-edit", "appointment-adjust-services", "appointment-note-edit", "appointment-check-in", "appointment-cancel", "appointment-no-show"]) {
      const control = detail(page).getByTestId(testid);
      await expect(control, `${testid} vanished instead of explaining itself`).toBeVisible();
      await expect(control).toBeDisabled();
      await expect(control).toHaveAttribute("title", SCOPE);
      await expect(control).toHaveAttribute("title", /assigned to another groomer/u);
    }
    // Nothing disabled is promoted: no primary at all on a visit Grace cannot move on.
    await expect(detail(page).locator("footer .primary")).toHaveCount(0);
    await detail(page).locator("[data-surface-close]").click();
    await expect(detail(page)).toBeHidden();

    // GRACE'S OWN VISIT. The same controls, pressable, and Check In goes through.
    await openDetail(page, graces.id);
    for (const testid of ["appointment-groomer-edit", "appointment-adjust-services", "appointment-note-edit", "appointment-check-in"]) {
      await expect(detail(page).getByTestId(testid), testid).toBeEnabled();
    }
    await expect(detail(page).getByTestId("appointment-check-in")).toHaveClass(/\bprimary\b/u);
    await detail(page).getByTestId("appointment-check-in").click();
    await expect(async () => {
      const row = await (await request.get(`/api/appointments/${graces.id}`)).json() as { status: string };
      expect(row.status).toBe("checked_in");
    }).toPass();
    // Checked in, the service note is hers to write and Ready for Pickup is hers to press.
    await expect(detail(page).getByTestId("appointment-service-note-edit")).toBeEnabled();
    await expect(detail(page).getByTestId("appointment-ready")).toBeEnabled();
  });

test("the card's overflow menu is gated the same way: a colleague's items are disabled with the key named",
  async ({ page, request, tenant }) => {
    const { grace, graces, gabriels } = await twoGroomers(request, tenant);
    await login(page, grace.email, password);
    await openCalendar(page);

    // GABRIEL'S CARD. Drawn, disabled, and each item names the scope key.
    const theirs = page.locator(`.week-appointment[data-appointment-id="${gabriels.id}"]`);
    await theirs.getByRole("button", { name: /Appointment actions for/ }).click();
    for (const name of ["Check in", "Move", "Cancel appointment", "No show"]) {
      const menuItem = theirs.getByRole("menuitem", { name });
      await expect(menuItem, `${name} vanished instead of explaining itself`).toBeVisible();
      await expect(menuItem).toBeDisabled();
      await expect(menuItem).toHaveAttribute("title", SCOPE);
    }
    // View / Edit is reading, and reading is not scoped.
    await expect(theirs.getByRole("menuitem", { name: "View / Edit" })).toBeEnabled();
    await page.keyboard.press("Escape");

    // GRACE'S CARD. The same items, pressable.
    const mine = page.locator(`.week-appointment[data-appointment-id="${graces.id}"]`);
    await mine.getByRole("button", { name: /Appointment actions for/ }).click();
    for (const name of ["Check in", "Move", "Cancel appointment", "No show"]) {
      await expect(mine.getByRole("menuitem", { name }), name).toBeEnabled();
    }
    await page.keyboard.press("Escape");
  });

test("on the grid a groomer drags their own card and not a colleague's, and cannot drop onto a colleague's column",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "drag is a fine-pointer affordance");
    const { gabriel, grace, graces, gabriels } = await twoGroomers(request, tenant);
    await login(page, grace.email, password);
    await openCalendar(page);

    await expect(page.locator(`.week-appointment[data-appointment-id="${graces.id}"]`)).toHaveAttribute("data-draggable", "true");
    await expect(page.locator(`.week-appointment[data-appointment-id="${gabriels.id}"]`)).not.toHaveAttribute("data-draggable", "true");

    const scheduleCalls: string[] = [];
    await page.route("**/api/appointments/*/schedule", async (route) => {
      scheduleCalls.push(route.request().method());
      await route.continue();
    });
    // Her own card onto Gabriel's column: refused before the confirmation and before any request,
    // naming the key.
    await dragAppointmentToSlot(page, { appointmentId: graces.id, slot: `${tenant.anchor}T13:00`, groomerId: gabriel.id });
    await expect(page.locator("#toast")).toContainText("appointments.edit_all_staff");
    await expect(page.getByTestId("stacked-dialog")).toBeHidden();
    expect(scheduleCalls).toEqual([]);
    // Her own card within her own column: the ordinary confirmation, then the ordinary PATCH.
    await dragAppointmentToSlot(page, { appointmentId: graces.id, slot: `${tenant.anchor}T13:00`, groomerId: tenant.employeeId });
    await expect(page.getByTestId("stacked-dialog")).toBeVisible();
    await page.getByTestId("stacked-dialog-confirm").click();
    await expect(async () => { expect(scheduleCalls).toEqual(["PATCH"]); }).toPass();
    await expect(page.locator(`.week-appointment[data-appointment-id="${graces.id}"] time`)).toContainText("1:00");
  });

test("block time is scoped the same way: create offers only themselves, a colleague's block is read-only",
  async ({ page, request, tenant }) => {
    const { gabriel, grace } = await twoGroomers(request, tenant);
    const lunch = await request.post("/api/blocked-times", { data: {
      employeeId: gabriel.id, locationId: tenant.locationId, localStart: `${tenant.anchor}T14:00`,
      localEnd: `${tenant.anchor}T14:30`, reason: "Break", expectedLocationVersion: tenant.locationVersion
    } });
    expect(lunch.ok(), await lunch.text()).toBeTruthy();
    await login(page, grace.email, password);
    await openCalendar(page);

    // THE CREATE DIALOG offers Grace and nobody else, pre-selected.
    await page.getByTestId("new-action-trigger").click();
    await page.getByTestId("new-action-menu").getByRole("menuitem", { name: "New Block Time" }).click();
    const staff = page.getByTestId("modal").locator('select[name="employeeId"]');
    await expect(staff).toHaveValue(tenant.employeeId);
    // The placeholder and Grace; Gabriel is not offered.
    await expect(staff.locator("option:not([value=''])")).toHaveCount(1);
    await expect(staff.locator(`option[value="${gabriel.id}"]`)).toHaveCount(0);
    await page.getByTestId("modal").getByRole("button", { name: "Close" }).click();

    // GABRIEL'S LUNCH: openable, read-only, the scope key named, and not draggable.
    const band = page.getByTestId("calendar-block").first();
    await expect(band).not.toHaveAttribute("data-draggable", "true");
    await band.locator(".calendar-block-open").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
    await expect(page.getByTestId("blocked-time-update")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-update")).toHaveAttribute("title", SCOPE);
    await expect(page.getByTestId("blocked-time-delete")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-locked")).toContainText("appointments.edit_all_staff");
    await page.getByTestId("blocked-time-cancel").click();
  });

test("a groomer reads the receipt of their own settled visit, and not a colleague's",
  async ({ page, request, tenant }) => {
    // BACKEND-DEPENDENT: `GET /api/invoices/:id/receipt` answers a caller without payments.view
    // when the invoice is settled AND its appointment is assigned to the caller's employee. The
    // footer mirrors the rule: on Grace's own paid visit the Invoice is enabled and leads, with
    // the sheet beside it; on Gabriel's paid visit it is drawn, disabled, and names the key.
    const { grace, graces, gabriels } = await twoGroomers(request, tenant);
    await settle(request, graces);
    await settle(request, gabriels);
    await login(page, grace.email, password);
    await openCalendar(page);

    // GRACE'S OWN. Enabled, primary, and it opens the real Invoice workspace off the real read.
    await openDetail(page, graces.id);
    const invoice = detail(page).getByTestId("appointment-invoice");
    await expect(invoice).toBeEnabled();
    await expect(invoice).toHaveClass(/\bprimary\b/u);
    await expect(detail(page).locator("footer .primary")).toHaveCount(1);
    await expect(detail(page).getByTestId("appointment-ticket")).toBeVisible();
    const receiptRead = page.waitForResponse((response) =>
      /\/api\/invoices\/[^/]+\/receipt$/u.test(response.url()) && response.request().method() === "GET");
    await invoice.click();
    expect((await receiptRead).status()).toBe(200);
    const workspace = page.getByTestId("invoice-surface");
    await expect(workspace).toBeVisible();
    await expect(workspace.getByTestId("invoice-document-title")).toContainText(/Invoice/u);
    // Reading, not correcting: the money controls answer to checkout.perform, which she lacks.
    await expect(workspace.locator(".void-payment, .refund-payment")).toHaveCount(0);
    await workspace.locator("[data-surface-close]").click();
    await expect(workspace).toBeHidden();
    await expect(detail(page)).toBeVisible();
    await detail(page).locator("[data-surface-close]").click();
    await expect(detail(page)).toBeHidden();

    // GABRIEL'S. The document exists and the footer says so; it is not hers to open.
    await openDetail(page, gabriels.id);
    const refused = detail(page).getByTestId("appointment-invoice");
    await expect(refused).toBeVisible();
    await expect(refused).toBeDisabled();
    await expect(refused).toHaveAttribute("title", /permission to view invoices/u);
    // Nothing disabled is promoted: the sheet leads a colleague's settled visit.
    await expect(detail(page).getByTestId("appointment-ticket")).toHaveClass(/\bprimary\b/u);
  });
