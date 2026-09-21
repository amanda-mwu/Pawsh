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

/** The empty row for `time` in the fixture groomer's column, whichever grid is on screen. */
function row(page: Page, tenant: { anchor: string; employeeId: string }, time: string): Locator {
  return page.locator(`[data-slot="${tenant.anchor}T${time}"][data-slot-groomer="${tenant.employeeId}"]`).first();
}
/**
 * Measured WITHOUT scrolling, deliberately: every rectangle in one of these tests is compared with
 * another, and a scroll between two measurements would move the second against the first. The one
 * scroll each test makes is made once, up front, before anything is measured.
 */
async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await locator.boundingBox();
  expect(rect, "the element being measured has to be drawn").not.toBeNull();
  return rect!;
}

test("a visit booked at 10:45 is painted from the middle of the 10:30 row, as tall as it is long",
  async ({ page, request, tenant }) => {
    // THE PAINT USED TO LIE. A 10:45 visit was drawn from the 10:30 line, and a 90-minute one was
    // drawn four whole rows tall, while the strip on the card said 10:45-12:15. Human QA read that
    // as the calendar rounding the time. The card is measured here against the row lines it sits
    // between, in pixels, so a return to whole-row painting cannot pass.
    const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T10:45` });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    const card = page.locator(`[data-appointment-id="${appointment.id}"]`).first();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("style", /--minute-offset:15;--minute-span:90/u);
    await card.scrollIntoViewIfNeeded();
    const halfPast = await box(row(page, tenant, "10:30"));
    const eleven = await box(row(page, tenant, "11:00"));
    const twelve = await box(row(page, tenant, "12:00"));
    const painted = await box(card);
    // Begins 15 of the row's 30 minutes down the 10:30 row - halfway - plus the 2px gutter every
    // card keeps, and well short of the 11:00 line.
    expect(Math.abs(painted.y - (halfPast.y + halfPast.height / 2 + 2))).toBeLessThanOrEqual(1.5);
    expect(painted.y).toBeLessThan(eleven.y);
    // Ends at 12:15, halfway down the 12:00 row: three rows tall for 90 minutes, not four for the
    // rows it touches.
    expect(Math.abs(painted.y + painted.height - (twelve.y + twelve.height / 2 - 2))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(painted.height - (halfPast.height * 3 - 4))).toBeLessThanOrEqual(1.5);
  });

test.describe("the drop preview", () => {
  // Tall enough that the whole working day is on screen without the grid scrolling. The grid
  // scrolls itself while a carried card is held within 48px of its edge, which would move the row
  // under a pointer this test holds still; with nothing to scroll, the row under the pointer is
  // the row the test aimed at.
  test.use({ viewport: { width: 1280, height: 1100 } });

  test("the ghost under a carried card names the quarter hour it will land on, and the drop agrees",
  async ({ page, request, tenant }) => {
    const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    const target = row(page, tenant, "14:00");
    await target.scrollIntoViewIfNeeded();
    const to = await box(target);
    const grip = page.locator(`[data-appointment-id="${appointment.id}"] .appointment-pet`).first();
    const from = await box(grip);
    const preview = page.getByTestId("calendar-drop-preview");
    await expect(preview).toHaveCount(0);

    // Pick the card up and carry it a tenth of the way into the 14:00 row: the ghost says 2:05,
    // not 2:00 and not 2:15 - the preview is drawn on five-minute marks, never rounded further.
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 24);
    await page.mouse.move(to.x + to.width / 2, to.y + to.height * 0.1, { steps: 8 });
    await expect(preview).toBeVisible();
    await expect(preview.locator(".calendar-drop-time")).toHaveText(/^(2:05 PM|14:05)$/u);
    await expect(preview).toHaveAttribute("data-drop-start", `${tenant.anchor}T14:05`);

    // Carried on to the middle of the SAME row: the ghost moves within the row to 2:15, sits
    // halfway down it, and is the card's own 90 minutes tall.
    await page.mouse.move(to.x + to.width / 2, to.y + to.height * 0.5, { steps: 4 });
    await expect(preview.locator(".calendar-drop-time")).toHaveText(/^(2:15 PM|14:15)$/u);
    await expect(preview).toHaveAttribute("data-drop-start", `${tenant.anchor}T14:15`);
    await expect(preview).toHaveAttribute("style", /--minute-offset: ?15; ?--minute-span: ?90/u);
    const ghost = await box(preview);
    expect(Math.abs(ghost.y - (to.y + to.height / 2 + 2))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(ghost.height - (to.height * 3 - 4))).toBeLessThanOrEqual(1.5);

    // Let go: the ghost is gone, the question names the minute the ghost named, and the server
    // stores exactly that minute.
    await page.mouse.up();
    await expect(preview).toHaveCount(0);
    const confirm = page.getByTestId("stacked-dialog");
    await expect(confirm).toBeVisible();
    await expect(page.getByTestId("reschedule-confirm-question")).toContainText(/2:15 PM|14:15/u);
    await confirm.getByTestId("stacked-dialog-confirm").click();
    await expect(confirm).toBeHidden();
    await expect.poll(() => startClock(request, appointment.id)).toBe("14:15");
    // And the moved card is painted at 2:15, halfway down the 2:00 row, not snapped to the row.
    const moved = page.locator(`[data-appointment-id="${appointment.id}"]`).first();
    await expect(moved).toHaveAttribute("style", /--minute-offset:15;--minute-span:90/u);
    const landed = await box(moved);
    const twoOclock = await box(row(page, tenant, "14:00"));
    expect(Math.abs(landed.y - (twoOclock.y + twoOclock.height / 2 + 2))).toBeLessThanOrEqual(1.5);
  });
});
