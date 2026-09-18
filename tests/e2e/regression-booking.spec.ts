import type { Locator, Page } from "@playwright/test";
import {
  createAppointment,
  createMember,
  expect,
  login,
  prepareReceipt,
  setMemberPermissions,
  test,
  type TenantFixture
} from "./fixtures/tenant.js";
import { zonedIso } from "./helpers/date.js";
import {
  chooseBookingClient,
  chooseBookingPet,
  fillBooking,
  openBooking as openBookingWorkspace
} from "./helpers/booking.js";

async function openBooking(page: Page, tenant: TenantFixture, hour: number): Promise<void> {
  await openBookingWorkspace(page);
  await chooseBookingClient(page, tenant.customerId);
  await chooseBookingPet(page, tenant.petId);
  await fillBooking(page, {
    employeeId: tenant.employeeId,
    startAt: `${tenant.anchor}T${String(hour).padStart(2,"0")}:00`
  });
}

async function openCardAction(card:Locator,name:"Move"|"Cancel appointment"):Promise<void>{
  await card.page().waitForLoadState("networkidle");
  await card.getByRole("button",{name:/Appointment actions for/}).filter({visible:true}).click();
  await card.page().getByRole("menuitem",{name,exact:true}).filter({visible:true}).click();
}

test("@regression-booking creates a booking and preserves it after reload", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await openBooking(page, tenant, 9);
  await page.getByTestId("booking-submit").click();
  await expect(page.getByTestId("booking-dialog")).toBeHidden();
  await expect(page.getByTestId("calendar-list")).toContainText("Charlie");
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar-list")).toContainText("Charlie");
});

test("@regression-booking defaults from the last paid visit without service-to-groomer labels and permits overrides", async ({ page, request, tenant }) => {
  await prepareReceipt(request, tenant);
  const alternate=await (await request.post("/api/employees",{data:{displayName:"Alternate Groomer",serviceIds:[tenant.serviceId]}})).json() as {id:string};
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await openBookingWorkspace(page);
  await chooseBookingClient(page, tenant.customerId);
  await chooseBookingPet(page, tenant.petId);
  const groomer=page.locator('#booking-dialog select[name="employeeId"]');
  const service=page.locator(`#booking-dialog input[name="serviceIds"][value="${tenant.serviceId}"]`);
  await expect(groomer).toHaveValue(tenant.employeeId);
  await expect(service).toBeChecked();
  await expect(page.getByTestId("booking-defaults-note")).toContainText("last paid visit");
  await expect(page.getByTestId("booking-dialog")).not.toContainText("Not assigned to");
  await groomer.selectOption(alternate.id);
  await service.uncheck();
  await page.locator('#booking-dialog [name="startAt"]').fill(`${tenant.anchor}T11:00`);
  await expect(groomer).toHaveValue(alternate.id);
  await expect(service).not.toBeChecked();
});

// The last groomer and the default services deliberately read from different visits: an
// unpaid visit still tells you who saw the pet, but it is not evidence of a settled service
// selection, so nothing is pre-ticked and the workspace says why.
test("@regression-booking carries the last groomer but no services when the pet has no paid visit", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await openBookingWorkspace(page);
  await chooseBookingClient(page, tenant.customerId);
  await chooseBookingPet(page, tenant.petId);
  await expect(page.locator('#booking-dialog select[name="employeeId"]')).toHaveValue(tenant.employeeId);
  await expect(page.locator(`#booking-dialog input[name="serviceIds"][value="${tenant.serviceId}"]`)).not.toBeChecked();
  await expect(page.getByTestId("booking-defaults-note")).toContainText("no paid visit yet");
});

/**
 * OVERLAPS ARE A PERMISSION, NOT A PROMPT. A caller holding `appointments.override_conflict` -
 * the owner, manager and receptionist presets - books over an existing appointment on the first
 * request and the server records the overlap; there is no "Book anyway" round trip any more. A
 * caller without the key is refused 409 with the overlap named, in a sentence, with nothing to
 * press: the workspace stays open so the time can be corrected.
 */
test("@regression-booking presents a conflict to a role that cannot overlap, and preserves recovery", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  const member = await createMember(
    request,
    `scheduler-recovery+${tenant.runId}@pawsh-test.example`,
    // A desk member with no employee record of its own: booking onto a groomer's calendar is
    // all-staff scheduling, so the role carries the key 0057 gives every such role.
    ["calendar.view","appointments.view","appointments.create","appointments.edit_all_staff","customers.view","pets.view","services.manage"]
  );
  await login(page, member.email);
  await page.getByTestId("nav-calendar").click();
  await openBooking(page, tenant, 9);
  await page.getByTestId("booking-submit").click();
  await expect(page.locator("#booking-error")).toContainText("already has an overlapping appointment");
  await expect(page.locator("#booking-error")).toContainText("cannot book over another appointment");
  await expect(page.locator("#booking-error").getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("confirm-conflict-override")).toHaveCount(0);
  await expect(page.locator('#booking-dialog [name="startAt"]')).toHaveValue(`${tenant.anchor}T09:00`);
  await page.locator('#booking-dialog [name="startAt"]').fill(`${tenant.anchor}T11:00`);
  await page.getByTestId("booking-submit").click();
  await expect(page.getByTestId("booking-dialog")).toBeHidden();
  await expect(page.getByTestId("calendar-list").locator(".appointment-pet", { hasText: "Charlie" })).toHaveCount(2);
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
  await page.getByTestId("booking-submit").click();
  await expect(page.getByTestId("booking-submit")).toBeDisabled();
  release();
  await expect(page.getByTestId("booking-dialog")).toBeHidden();
  expect(requests).toBe(1);
  await expect(page.getByTestId("calendar-list").locator(".appointment-pet", { hasText: "Charlie" })).toHaveCount(1);
});

test("@regression-booking books over an existing appointment directly with the key, and renders both", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await openBooking(page, tenant, 9);
  const created = page.waitForResponse((response) =>
    response.url().endsWith("/api/appointments") && response.request().method() === "POST");
  await page.getByTestId("booking-submit").click();
  // One request, saved on the first ask; the server says the overlap was recorded.
  const body = await (await created).json() as { conflictOverridden?: boolean; scheduling?: { overrideApplied?: boolean } };
  expect(body.conflictOverridden).toBe(true);
  expect(body.scheduling?.overrideApplied).toBe(true);
  await expect(page.getByTestId("booking-dialog")).toBeHidden();
  await expect(page.getByTestId("confirm-conflict-override")).toHaveCount(0);
  await expect(page.getByTestId("calendar-list").locator(".appointment-pet", { hasText: "Charlie" })).toHaveCount(2);
  // No badge, no "intentional overlap" copy: an overlap is an ordinary appointment on the card.
  await expect(page.getByTestId("conflict-override")).toHaveCount(0);
  await expect(page.getByTestId("calendar-list")).not.toContainText(/intentional overlap/iu);
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar-list").locator(".appointment-pet", { hasText: "Charlie" })).toHaveCount(2);
});

test("@regression-booking hides override UX and denies direct intent without permission", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  const member = await createMember(
    request,
    `scheduler+${tenant.runId}@pawsh-test.example`,
    [
      "calendar.view","appointments.view","appointments.create","appointments.edit_all_staff",
      "customers.view","pets.view","services.manage"
    ]
  );
  await login(page, member.email);
  await page.getByTestId("nav-calendar").click();
  await openBooking(page, tenant, 9);
  await page.getByTestId("booking-submit").click();
  await expect(page.locator("#booking-error")).toContainText("overlapping appointment");
  await expect(page.getByTestId("confirm-conflict-override")).toHaveCount(0);

  const status = await page.evaluate(async (payload) => {
    const response = await fetch("/api/appointments", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
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

test("@regression-booking a revoked override key is decided by the server on the next request", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  const retainedPermissions = [
    "calendar.view","appointments.view","appointments.create","appointments.edit_all_staff",
    "customers.view","pets.view","services.manage"
  ];
  const member = await createMember(
    request,
    `override+${tenant.runId}@pawsh-test.example`,
    [...retainedPermissions,"appointments.override_conflict"]
  );
  await login(page, member.email);
  await page.getByTestId("nav-calendar").click();
  // Holding the key: the overlap is saved on the first request, with nothing to confirm.
  await openBooking(page, tenant, 9);
  await page.getByTestId("booking-submit").click();
  await expect(page.getByTestId("booking-dialog")).toBeHidden();
  await expect(page.getByTestId("calendar-list").locator(".appointment-pet", { hasText: "Charlie" })).toHaveCount(2);

  // A member's access is their role now, so revoking mid-session edits the role they hold. The
  // per-member permission column this used to write was retired with migration 0042. The client
  // still believes it holds the key; the server, reading the role under the transaction, does not.
  await setMemberPermissions(request, member.roleId, retainedPermissions);
  await openBooking(page, tenant, 9);
  await page.getByTestId("booking-submit").click();
  await expect(page.locator("#booking-error")).toContainText("already has an overlapping appointment");
  await expect(page.locator("#booking-error")).not.toContainText("override_conflict");
  await expect(page.locator("#booking-error").getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("confirm-conflict-override")).toHaveCount(0);
  await expect(page.getByTestId("calendar-list").locator(".appointment-pet", { hasText: "Charlie" })).toHaveCount(2);
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
  await openCardAction(card,"Move");
  await page.locator('select[name="employeeId"]').selectOption(tenant.employeeId);
  await page.getByTestId("field-startAt").fill(`${tenant.anchor}T11:00`);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.locator(`[data-appointment-id="${appointment.id}"] time`)).toContainText("11:00");
});

test("@regression-booking reschedules onto an existing appointment directly with the key", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  const movable = await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 12) });
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await openCardAction(page.locator(`[data-appointment-id="${movable.id}"]`),"Move");
  await page.locator('select[name="employeeId"]').selectOption(tenant.employeeId);
  await page.getByTestId("field-startAt").fill(`${tenant.anchor}T09:30`);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await expect(page.getByTestId("confirm-conflict-override")).toHaveCount(0);
  await expect(page.getByTestId("conflict-override")).toHaveCount(0);
  await expect(page.locator(`[data-appointment-id="${movable.id}"] time`)).toContainText("9:30");
});

test("@regression-booking cancels persistently and releases employee capacity", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { startAt: zonedIso(tenant.anchor, 9) });
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  page.once("dialog", (dialog) => dialog.accept());
  await openCardAction(page.locator(`[data-appointment-id="${appointment.id}"]`),"Cancel appointment");
  await expect(page.locator(`[data-appointment-id="${appointment.id}"]`)).toContainText("cancelled");
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.locator(`[data-appointment-id="${appointment.id}"]`)).toContainText("cancelled");
  await openBooking(page, tenant, 9);
  await page.getByTestId("booking-submit").click();
  await expect(page.getByTestId("booking-dialog")).toBeHidden();
});

// Category order and collapsing come from the catalog, so the work a salon books every day
// leads and the long tail stays folded until it is wanted.
test("@regression-booking leads the service picker with core grooming and folds the rest", async ({ page, request, tenant }) => {
  // Names carry the run id because the tenant fixture already seeds a starter catalog and an
  // active duplicate name is refused.
  const polish = `Nail Polish ${tenant.runId.slice(-6)}`;
  for (const [name, category] of [
    [`Bath + Brush ${tenant.runId.slice(-6)}`,"DOG_BASE"],
    [polish,"DOG_ADDON"],
    [`Cat Sanitary ${tenant.runId.slice(-6)}`,"CAT"]
  ] as const) {
    expect((await request.post("/api/services", { data: {
      name, category, baseDurationMinutes: 60, basePriceMinor: 2500, pricingMode: "FIXED", active: true
    }})).status()).toBe(201);
  }
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await openBookingWorkspace(page);
  await chooseBookingClient(page, tenant.customerId);

  const sections = page.locator("#appointment-service-options .service-section");
  expect(await sections.locator(".service-section-title").allTextContents())
    .toEqual(["Core grooming","Add-ons","Care & finishing","Cat","Other"]);
  await expect(sections.first()).toHaveAttribute("open", "");
  await expect(sections.nth(1)).not.toHaveAttribute("open", "");
  await expect(page.getByRole("checkbox", { name: polish })).toHaveCount(0);

  const addons = sections.nth(1);
  await addons.locator("summary").click();
  await expect(addons).toHaveAttribute("open", "");
  await page.getByRole("checkbox", { name: polish }).check();
  // The header reports the selection so a folded section never hides what is booked.
  await expect(addons.locator("[data-section-count]")).toHaveText(/^1 of \d+ selected$/);
});

// A default carried over from the last paid visit lands in a section the operator would
// otherwise have to guess was holding it.
test("@regression-booking opens the section holding a service carried from the last paid visit", async ({ page, request, tenant }) => {
  await prepareReceipt(request, tenant);
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await openBookingWorkspace(page);
  await chooseBookingClient(page, tenant.customerId);
  await chooseBookingPet(page, tenant.petId);
  const holding = page.locator("#appointment-service-options .service-section")
    .filter({ has: page.locator(`input[value="${tenant.serviceId}"]`) });
  await expect(holding).toHaveAttribute("open", "");
  await expect(page.getByRole("checkbox", { name: /Full Groom/ })).toBeChecked();
});
