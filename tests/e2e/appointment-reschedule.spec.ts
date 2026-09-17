import { test, expect, login, createAppointment, createMember, password } from "./fixtures/tenant.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { permissionPresets } from "@pawsh/domain";
import { dismissVaccinationPrompt } from "./helpers/booking.js";

/**
 * RESCHEDULING A VISIT THAT DID NOT HAPPEN.
 *
 * A cancelled or no-show visit used to offer Print Ticket and Close and nothing else, so the desk
 * rebooking a client who rang back retyped everything. Reschedule opens the ONE booking workflow
 * with the client, the pet, the services and the groomer already in place; the operator picks a
 * date and time and confirms; a NEW scheduled visit exists and the cancelled one is exactly as it
 * was. No new lifecycle status, no mutation of the old row.
 *
 * What only a browser can hold: that the dialog opened is the real booking dialog with the real
 * prefills, that the create went out with the lineage field, and that the calendar afterwards has
 * both rows in their own states.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");

async function cancelled(api: APIRequestContext, tenant: Parameters<typeof createAppointment>[1], status = "cancelled") {
  const appointment = await createAppointment(api, tenant, { localStart: `${tenant.anchor}T09:00` });
  const response = await api.post(`/api/appointments/${appointment.id}/transition`, {
    data: { status, version: appointment.version }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return appointment;
}

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

async function read(api: APIRequestContext, id: string): Promise<Record<string, unknown>> {
  const response = await api.get(`/api/appointments/${id}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as Record<string, unknown>;
}

test("Reschedule books a new scheduled visit from a cancelled one and leaves the original cancelled",
  async ({ page, request, tenant }) => {
    const original = await cancelled(request, tenant);
    const before = await read(request, original.id);
    await login(page, tenant.ownerEmail);
    await openDetail(page, original.id);

    // THE FOOTER. Reschedule leads a cancelled visit; the sheet and Close are utility.
    const reschedule = detail(page).getByTestId("appointment-reschedule");
    await expect(reschedule).toBeEnabled();
    await expect(reschedule).toHaveClass(/\bprimary\b/u);
    await expect(detail(page).locator("footer .primary")).toHaveCount(1);

    // Every create, with its body, so the lineage is a fact about the wire.
    const creates: Array<Record<string, unknown>> = [];
    await page.route("**/api/appointments", async (route) => {
      if (route.request().method() === "POST") creates.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.continue();
    });

    await reschedule.click();
    // THE SAME BOOKING DIALOG, prefilled. The surface came down first: booking is navigation.
    await expect(detail(page)).toBeHidden();
    const dialog = page.getByTestId("booking-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#booking-title")).toHaveText("Reschedule Appointment");
    await expect(page.getByTestId("booking-client-name")).toContainText("Emma Johnson");
    await dismissVaccinationPrompt(page);
    await expect(page.getByTestId("booking-pet-name")).toHaveText("Charlie");
    await expect(page.locator('#booking-dialog select[name="employeeId"]')).toHaveValue(tenant.employeeId);
    await expect(page.locator(`#booking-dialog input[name="serviceIds"][value="${tenant.serviceId}"]`)).toBeChecked();
    await expect(page.getByTestId("booking-defaults-note")).toContainText("carried over from the cancelled visit");

    // The operator picks the new time and confirms. Nothing else is typed.
    await page.locator('#booking-dialog [name="startAt"]').fill(`${tenant.anchor}T13:00`);
    await page.getByTestId("booking-submit").click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // ONE CREATE, CARRYING THE LINEAGE. The cancelled row was never PATCHed or transitioned.
    expect(creates).toHaveLength(1);
    expect(creates[0]!.rescheduledFromAppointmentId).toBe(original.id);
    expect(creates[0]!.customerId).toBe(tenant.customerId);
    expect(creates[0]!.petId).toBe(tenant.petId);
    expect(creates[0]!.serviceIds).toEqual([tenant.serviceId]);
    expect(creates[0]!.localStart).toBe(`${tenant.anchor}T13:00`);

    // THE SERVER'S ANSWER. A new scheduled visit at 1:00, and the original untouched - same
    // status, same version, same start.
    const list = await request.get(`/api/appointments?localDate=${tenant.anchor}&days=1`);
    const rows = (await list.json()) as Array<{ id: string; status: string; scheduledLocalStart: string }>;
    const created = rows.find((row) => row.id !== original.id && row.status === "scheduled");
    expect(created, "a new scheduled visit exists").toBeTruthy();
    expect(created!.scheduledLocalStart).toBe(`${tenant.anchor}T13:00`);
    const after = await read(request, original.id);
    expect(after.status).toBe("cancelled");
    expect(after.version).toBe(before.version);
    expect(after.scheduledLocalStart).toBe(before.scheduledLocalStart);

    // And the calendar shows both: the cancelled 9:00 and the scheduled 1:00.
    await expect(page.locator(`[data-appointment-id="${original.id}"]`).first()).toHaveClass(/status-cancelled/u);
    await expect(page.locator(`[data-appointment-id="${created!.id}"]`).first()).toHaveClass(/status-scheduled/u);
  });

test("Reschedule is there the moment a visit is cancelled, from the surface and from the card menu",
  async ({ page, request, tenant }) => {
    // Human QA cancelled Boba as the owner and found no Reschedule. Two doors to a cancellation,
    // and the footer after each: cancelled FROM THE SURFACE, the surface redraws in place and
    // Reschedule leads without anybody reopening it; cancelled FROM THE CARD MENU, opening the
    // visit afterwards leads with it too.
    const fromSurface = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const fromCard = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T13:00` });
    await login(page, tenant.ownerEmail);
    page.on("dialog", (dialog) => dialog.accept());

    // THE SURFACE. Cancel is a confirmation, a transition, a calendar refresh and a redraw of the
    // open surface from what the server now says - and what it says is cancelled.
    await openDetail(page, fromSurface.id);
    await expect(detail(page).getByTestId("appointment-reschedule")).toHaveCount(0);
    await detail(page).getByTestId("appointment-cancel").click();
    await expect(detail(page).getByTestId("appointment-status")).toHaveText("cancelled");
    const reschedule = detail(page).getByTestId("appointment-reschedule");
    await expect(reschedule).toBeVisible();
    await expect(reschedule).toBeEnabled();
    await expect(reschedule).toHaveClass(/\bprimary\b/u);
    await expect(detail(page).locator("footer .primary")).toHaveCount(1);
    // The controls of a live visit are gone with it: nothing to cancel twice.
    await expect(detail(page).getByTestId("appointment-cancel")).toHaveCount(0);
    await detail(page).getByTestId("appointment-close").click();
    await expect(detail(page)).toBeHidden();

    // THE CARD MENU. The same transition from the grid, then the visit opened.
    const card = page.locator(`[data-appointment-id="${fromCard.id}"]`).first();
    await card.getByRole("button", { name: /Appointment actions for/ }).click();
    await page.locator(`.terminal-action[data-id="${fromCard.id}"][data-status="cancelled"]`).filter({ visible: true }).click();
    await expect(page.locator(`[data-appointment-id="${fromCard.id}"]`).first()).toHaveClass(/status-cancelled/u);
    await page.locator(`[data-appointment-id="${fromCard.id}"] .calendar-open`).first().click();
    await expect(detail(page)).toBeVisible();
    await expect(detail(page).getByTestId("appointment-status")).toHaveText("cancelled");
    await expect(detail(page).getByTestId("appointment-reschedule")).toBeEnabled();
    await expect(detail(page).getByTestId("appointment-reschedule")).toHaveClass(/\bprimary\b/u);
    await detail(page).getByTestId("appointment-close").click();

    // GRACE. A groomer holds no appointments.create, so on the same cancelled visit Reschedule
    // is DRAWN, DISABLED, and names the key - never absent - and Close takes the slot.
    const grace = await createMember(request, `grace+${tenant.runId}@pawsh-test.example`, [...permissionPresets.groomer!]);
    await login(page, grace.email, password);
    await openDetail(page, fromSurface.id);
    const refused = detail(page).getByTestId("appointment-reschedule");
    await expect(refused).toBeVisible();
    await expect(refused).toBeDisabled();
    await expect(refused).toHaveAttribute("title", /appointments\.create/u);
    await expect(detail(page).getByTestId("appointment-close")).toHaveClass(/\bprimary\b/u);
  });

test("a no-show visit reschedules the same way, and a live one offers no Reschedule at all",
  async ({ page, request, tenant }) => {
    const noShow = await cancelled(request, tenant, "no_show");
    const live = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T11:00` });
    await login(page, tenant.ownerEmail);

    await openDetail(page, noShow.id);
    await expect(detail(page).getByTestId("appointment-reschedule")).toBeEnabled();
    await detail(page).getByTestId("appointment-close").click();
    await expect(detail(page)).toBeHidden();

    // A scheduled visit is MOVED, not rescheduled from scratch: the pencil and the drag do that.
    await page.locator(`[data-appointment-id="${live.id}"] .calendar-open`).first().click();
    await expect(detail(page)).toBeVisible();
    await expect(detail(page).getByTestId("appointment-reschedule")).toHaveCount(0);
    await expect(detail(page).getByTestId("appointment-groomer-edit")).toBeEnabled();
  });

test("Reschedule says which services it could not carry, and a role that cannot book is refused by name",
  async ({ page, request, tenant }) => {
    // Two services on the visit; one is retired from the catalog after the cancellation.
    const services = await (await request.get("/api/services")).json() as Array<{ id: string; name: string; version?: number }>;
    const nailTrim = services.find((service) => service.name === "Nail Trim")!;
    const original = await createAppointment(request, tenant, {
      localStart: `${tenant.anchor}T09:00`, serviceIds: [tenant.serviceId, nailTrim.id]
    });
    const done = await request.post(`/api/appointments/${original.id}/transition`, {
      data: { status: "cancelled", version: original.version }
    });
    expect(done.ok(), await done.text()).toBeTruthy();
    const retired = await request.put(`/api/services/${nailTrim.id}`, {
      data: { name: "Nail Trim", baseDurationMinutes: 30, basePriceMinor: 2000, active: false }
    });
    expect(retired.ok(), await retired.text()).toBeTruthy();

    await login(page, tenant.ownerEmail);
    await openDetail(page, original.id);
    await detail(page).getByTestId("appointment-reschedule").click();
    await expect(page.getByTestId("booking-dialog")).toBeVisible();
    await dismissVaccinationPrompt(page);
    // The still-active service is ticked; the retired one is named as left out rather than
    // silently missing.
    await expect(page.locator(`#booking-dialog input[name="serviceIds"][value="${tenant.serviceId}"]`)).toBeChecked();
    await expect(page.locator(`#booking-dialog input[name="serviceIds"][value="${nailTrim.id}"]`)).toHaveCount(0);
    await expect(page.getByTestId("booking-defaults-note")).toContainText("No longer offered and left out: Nail Trim");
    await page.getByTestId("booking-dialog").getByRole("button", { name: "Close" }).click();

    // A member who may look but not book sees Reschedule refused with the key named, and Close
    // takes the primary slot instead - the footer promotes nothing disabled.
    const viewer = await createMember(request, `viewer+${tenant.runId}@pawsh-test.example`, ["calendar.view", "appointments.view"]);
    await login(page, viewer.email, password);
    await openDetail(page, original.id);
    const refused = detail(page).getByTestId("appointment-reschedule");
    await expect(refused).toBeDisabled();
    await expect(refused).toHaveAttribute("title", /appointments\.create/u);
    await expect(detail(page).getByTestId("appointment-close")).toHaveClass(/\bprimary\b/u);
  });

test("the activity feed on both visits names the reschedule", async ({ page, request, tenant }) => {
  // BACKEND-DEPENDENT: the server records `appointment.rescheduled_from` on the new row and
  // `appointment.rescheduled_as` on the source when the create carries the lineage field.
  const original = await cancelled(request, tenant);
  await login(page, tenant.ownerEmail);
  await openDetail(page, original.id);
  await detail(page).getByTestId("appointment-reschedule").click();
  await expect(page.getByTestId("booking-dialog")).toBeVisible();
  await dismissVaccinationPrompt(page);
  await page.locator('#booking-dialog [name="startAt"]').fill(`${tenant.anchor}T13:00`);
  await page.getByTestId("booking-submit").click();
  await expect(page.getByTestId("booking-dialog")).toBeHidden({ timeout: 15_000 });

  const list = await request.get(`/api/appointments?localDate=${tenant.anchor}&days=1`);
  const rows = (await list.json()) as Array<{ id: string; status: string }>;
  const created = rows.find((row) => row.id !== original.id && row.status === "scheduled")!;

  await page.locator(`[data-appointment-id="${created.id}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
  await detail(page).getByTestId("appointment-activity").locator("summary").click();
  // By the other visit's time, never by its id: the history says when, not which uuid.
  await expect(detail(page).getByTestId("appointment-activity")).toContainText(/Rescheduled from \d/u);
  await expect(detail(page).getByTestId("appointment-activity")).not.toContainText(original.id.slice(0, 8));
  await detail(page).locator("[data-surface-close]").click();

  await page.locator(`[data-appointment-id="${original.id}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
  await detail(page).getByTestId("appointment-activity").locator("summary").click();
  await expect(detail(page).getByTestId("appointment-activity")).toContainText(/Rescheduled as \d/u);
  await expect(detail(page).getByTestId("appointment-activity")).not.toContainText(created.id.slice(0, 8));
});
