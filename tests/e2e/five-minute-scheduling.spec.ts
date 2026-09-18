import { test, expect, login, createAppointment } from "./fixtures/tenant.js";
import { openBooking, chooseBookingClient, chooseBookingPet, fillBooking, dismissVaccinationPrompt } from "./helpers/booking.js";
import { dragAppointmentToSlot } from "./helpers/calendar.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * FIVE-MINUTE SCHEDULING, IN THE BROWSER.
 *
 * The server refuses any appointment whose minute is not on :00, :05 ... :55, and the calendar
 * still draws 30-minute rows. Everything in between is the client's, and this is it exercised
 * end to end: a booking typed at :05, a move to :10, a reschedule to :25, a typed :07 that the
 * field snaps to :05 before it is ever sent, and a card dropped two thirds of the way down a row
 * that lands :20 into it. `tests/ui/five-minute-scheduling.test.ts` holds the arithmetic.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail");

/** The visit's start as the salon's own wall clock says it, `HH:MM`. */
async function startClock(api: APIRequestContext, appointmentId: string): Promise<string> {
  const response = await api.get(`/api/appointments/${appointmentId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const { startAt } = (await response.json()) as { startAt: string };
  return new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(startAt));
}

async function openCalendar(page: Page): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

test("books at :05, moves to :10 and reschedules to :25 - every one a five-minute mark",
  async ({ page, request, tenant }) => {
    await login(page, tenant.ownerEmail);
    await openCalendar(page);

    // BOOKED AT :05. The field carries the five-minute step, and the request carries the minute.
    await openBooking(page);
    await chooseBookingClient(page, tenant.customerId);
    await chooseBookingPet(page, tenant.petId);
    await expect(page.locator('#booking-dialog [name="startAt"]')).toHaveAttribute("step", "300");
    await fillBooking(page, { employeeId: tenant.employeeId, startAt: `${tenant.anchor}T09:05` });
    const created = page.waitForResponse((response) =>
      response.url().endsWith("/api/appointments") && response.request().method() === "POST");
    await page.getByTestId("booking-submit").click();
    const booked = (await (await created).json()) as { id: string };
    await expect(page.getByTestId("booking-dialog")).toBeHidden();
    expect(await startClock(request, booked.id)).toBe("09:05");
    await expect(page.locator(`[data-appointment-id="${booked.id}"] time`).first()).toContainText("9:05");

    // MOVED TO :10, from the surface's groomer/time pencil.
    await page.locator(`[data-appointment-id="${booked.id}"] .calendar-open`).first().click();
    await expect(detail(page)).toBeVisible();
    await detail(page).getByTestId("appointment-groomer-edit").click();
    await expect(page.getByTestId("field-startAt")).toHaveAttribute("step", "300");
    await page.getByTestId("field-startAt").fill(`${tenant.anchor}T09:10`);
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();
    expect(await startClock(request, booked.id)).toBe("09:10");
    await page.keyboard.press("Escape");
    await expect(detail(page)).toBeHidden();

    // RESCHEDULED TO :25, from a cancelled visit through the prefilled booking dialog.
    const cancelled = await createAppointment(request, tenant, {
      localStart: `${tenant.anchor}T14:00`, customerId: tenant.rockyCustomerId, petId: tenant.rockyPetId
    });
    const cancel = await request.post(`/api/appointments/${cancelled.id}/transition`, {
      data: { status: "cancelled", version: cancelled.version }
    });
    expect(cancel.ok(), await cancel.text()).toBeTruthy();
    await page.reload();
    await openCalendar(page);
    await page.locator(`[data-appointment-id="${cancelled.id}"] .calendar-open`).first().click();
    await expect(detail(page)).toBeVisible();
    await detail(page).getByTestId("appointment-reschedule").click();
    await expect(page.getByTestId("booking-dialog")).toBeVisible();
    await dismissVaccinationPrompt(page);
    await page.locator('#booking-dialog [name="startAt"]').fill(`${tenant.anchor}T13:25`);
    const recreated = page.waitForResponse((response) =>
      response.url().endsWith("/api/appointments") && response.request().method() === "POST");
    await page.getByTestId("booking-submit").click();
    const rebooked = (await (await recreated).json()) as { id: string };
    await expect(page.getByTestId("booking-dialog")).toBeHidden({ timeout: 15_000 });
    expect(await startClock(request, rebooked.id)).toBe("13:25");
  });

test("a typed :07 is snapped to :05 as the field changes, so the server never sees it",
  async ({ page, request, tenant }) => {
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await openBooking(page);
    await chooseBookingClient(page, tenant.customerId);
    await chooseBookingPet(page, tenant.petId);
    await fillBooking(page, { employeeId: tenant.employeeId, startAt: `${tenant.anchor}T09:07` });
    const field = page.locator('#booking-dialog [name="startAt"]');
    // `fill` dispatches the change; the listener snaps the value before anything reads it.
    await field.blur();
    await expect(field).toHaveValue(`${tenant.anchor}T09:05`);
    const creates: Array<{ localStart: string }> = [];
    await page.route("**/api/appointments", async (route) => {
      if (route.request().method() === "POST") creates.push(route.request().postDataJSON() as { localStart: string });
      await route.continue();
    });
    await page.getByTestId("booking-submit").click();
    await expect(page.getByTestId("booking-dialog")).toBeHidden();
    expect(creates.map((each) => each.localStart)).toEqual([`${tenant.anchor}T09:05`]);
    const listed = await request.get(`/api/appointments?localDate=${tenant.anchor}&days=1`);
    expect(listed.ok(), await listed.text()).toBeTruthy();
    const [only] = (await listed.json()) as Array<{ id: string }>;
    expect(await startClock(request, only!.id)).toBe("09:05");
  });

test("a card dropped two thirds of the way down the 11:00 row lands at 11:20",
  async ({ page, request, tenant }) => {
    const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await dragAppointmentToSlot(page, {
      appointmentId: appointment.id, slot: `${tenant.anchor}T11:00`, groomerId: tenant.employeeId, at: 2 / 3
    });
    const confirm = page.getByTestId("stacked-dialog");
    await expect(confirm).toBeVisible();
    // The question names the minute the drop means, not the row's top.
    await expect(page.getByTestId("reschedule-confirm-question")).toContainText("11:20");
    await confirm.getByTestId("stacked-dialog-confirm").click();
    await expect(confirm).toBeHidden();
    await expect(page.getByTestId("modal")).toBeHidden();
    await expect.poll(() => startClock(request, appointment.id)).toBe("11:20");
    await expect(page.locator(`[data-appointment-id="${appointment.id}"] time`).first()).toContainText("11:20");

    // And the card menu's Move opens on the minute the drop chose.
    const card = page.locator(`[data-appointment-id="${appointment.id}"]`).first();
    await card.getByRole("button", { name: /Appointment actions for/ }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "Move", exact: true }).filter({ visible: true }).click();
    await expect(page.getByTestId("field-startAt")).toHaveValue(`${tenant.anchor}T11:20`);
    await page.keyboard.press("Escape");
  });
