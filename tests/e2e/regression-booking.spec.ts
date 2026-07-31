import type { Page } from "@playwright/test";
import {
  createAppointment,
  createMember,
  expect,
  login,
  test,
  type TenantFixture
} from "./fixtures/tenant.js";
import { zonedIso } from "./helpers/date.js";

async function openBooking(page: Page, tenant: TenantFixture, hour: number): Promise<void> {
  await page.getByTestId("calendar-add-appointment").click();
  await page.getByTestId("field-customerId").selectOption(tenant.customerId);
  await page.getByTestId("field-petId").selectOption(tenant.petId);
  await page.getByTestId("field-employeeId").selectOption(tenant.employeeId);
  await page.getByLabel("Full Groom").check();
  await page.getByTestId("field-startAt").fill(`${tenant.anchor}T${String(hour).padStart(2,"0")}:00`);
}

test("@regression-booking creates a booking and preserves it after reload", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await openBooking(page, tenant, 9);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await expect(page.getByTestId("calendar-list")).toContainText("Charlie");
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar-list")).toContainText("Charlie");
});

test("@regression-booking presents normal conflicts and preserves recovery choices", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await openBooking(page, tenant, 9);
  await page.getByTestId("modal-submit").click();
  await expect(page.locator("#modal-error")).toContainText("overlapping appointment");
  await expect(page.getByTestId("confirm-conflict-override")).toBeVisible();
  await expect(page.getByTestId("field-startAt")).toHaveValue(`${tenant.anchor}T09:00`);
  await page.getByTestId("field-startAt").fill(`${tenant.anchor}T11:00`);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await expect(page.getByTestId("calendar-list").getByText("Charlie")).toHaveCount(2);
});

test("@regression-booking disables duplicate UI submission and sends one mutation", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await openBooking(page, tenant, 9);
  let requests = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/appointments", async (route) => {
    if (route.request().method() === "POST") {
      requests += 1;
      await gate;
    }
    await route.continue();
  });
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal-submit")).toBeDisabled();
  release();
  await expect(page.getByTestId("modal")).toBeHidden();
  expect(requests).toBe(1);
  await expect(page.getByTestId("calendar-list").getByText("Charlie")).toHaveCount(1);
});

test("@regression-booking explicitly overrides a detected conflict and renders both appointments", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await openBooking(page, tenant, 9);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("confirm-conflict-override")).toHaveText("Book anyway");
  await page.getByTestId("confirm-conflict-override").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await expect(page.getByTestId("calendar-list").getByText("Charlie")).toHaveCount(2);
  await expect(page.getByTestId("conflict-override")).toHaveCount(1);
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar-list").getByText("Charlie")).toHaveCount(2);
});

test("@regression-booking hides override UX and denies direct intent without permission", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  const member = await createMember(
    request,
    `scheduler+${tenant.runId}@pawsh-test.example`,
    [
      "calendar.view","appointments.view","appointments.create",
      "customers.view","pets.view","services.manage"
    ]
  );
  await login(page, member.email);
  await page.getByTestId("nav-calendar").click();
  await openBooking(page, tenant, 9);
  await page.getByTestId("modal-submit").click();
  await expect(page.locator("#modal-error")).toContainText("overlapping appointment");
  await expect(page.getByTestId("confirm-conflict-override")).toHaveCount(0);

  const status = await page.evaluate(async (payload) => {
    const response = await fetch("/api/appointments", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, overrideConflict: true })
    });
    return response.status;
  }, {
    locationId: tenant.locationId,
    customerId: tenant.customerId,
    petId: tenant.petId,
    employeeId: tenant.employeeId,
    serviceIds: [tenant.serviceId],
    localStart: `${tenant.anchor}T09:00`,expectedLocationVersion:tenant.locationVersion
  });
  expect(status).toBe(403);
});

test("@regression-booking reconciles stale override permission without committing overlap", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  const retainedPermissions = [
    "calendar.view","appointments.view","appointments.create",
    "customers.view","pets.view","services.manage"
  ];
  const member = await createMember(
    request,
    `override+${tenant.runId}@pawsh-test.example`,
    [...retainedPermissions,"appointments.override_conflict"]
  );
  await login(page, member.email);
  await page.getByTestId("nav-calendar").click();
  await openBooking(page, tenant, 9);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("confirm-conflict-override")).toBeVisible();

  const revoked = await request.patch(`/api/members/${member.membershipId}/permissions`, {
    data: { permissions: retainedPermissions }
  });
  expect(revoked.status()).toBe(200);
  await page.getByTestId("confirm-conflict-override").click();
  await expect(page.locator("#modal-error")).toContainText("Missing permission: appointments.override_conflict");
  await expect(page.getByTestId("confirm-conflict-override")).toHaveCount(0);
  const me = await page.evaluate(async () => {
    const response = await fetch("/api/me", { credentials: "include" });
    return response.json();
  });
  expect(me.permissions).not.toContain("appointments.override_conflict");
});

test("@regression-booking reschedules atomically and persists the new time", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  const card = page.locator(`[data-appointment-id="${appointment.id}"]`);
  await card.getByRole("button", { name: "Move" }).click();
  await page.getByTestId("field-employeeId").selectOption(tenant.employeeId);
  await page.getByTestId("field-startAt").fill(`${tenant.anchor}T11:00`);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.locator(`[data-appointment-id="${appointment.id}"] time`)).toContainText("11:00");
});

test("@regression-booking explicitly overrides a conflicting reschedule", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  const movable = await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 12) });
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.locator(`[data-appointment-id="${movable.id}"]`).getByRole("button", { name: "Move" }).click();
  await page.getByTestId("field-employeeId").selectOption(tenant.employeeId);
  await page.getByTestId("field-startAt").fill(`${tenant.anchor}T09:30`);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("confirm-conflict-override")).toHaveText("Move anyway");
  await page.getByTestId("confirm-conflict-override").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await expect(page.getByTestId("conflict-override")).toHaveCount(1);
});

test("@regression-booking cancels persistently and releases employee capacity", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(`[data-appointment-id="${appointment.id}"]`).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(`[data-appointment-id="${appointment.id}"]`)).toContainText("cancelled");
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.locator(`[data-appointment-id="${appointment.id}"]`)).toContainText("cancelled");
  await openBooking(page, tenant, 9);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
});
