import { expect, type Page } from "@playwright/test";

/**
 * Helpers for the Create Appointment workspace.
 *
 * Booking is no longer a field list in the shared dialog. It is a two-pane workspace where
 * the client is chosen from a searchable list, the pet through a sub-dialog, and a lapsed
 * rabies record interrupts with a prompt that has to be answered before the form is reachable.
 * Tests drive it through these helpers so the sequence lives in one place.
 */

/** Open the workspace from the calendar's add button and wait for it to be interactive. */
export async function openBooking(page: Page): Promise<void> {
  await page.getByTestId("calendar-add-appointment").click();
  await expect(page.getByTestId("booking-client-search")).toBeVisible();
}

/**
 * Open the workspace from an empty calendar slot, which now offers Add or Block rather than
 * going straight to booking.
 */
export async function openSlotAction(
  page: Page,
  { slot, groomerId, action, view = "day" }:
    { slot: string; groomerId: string; action: "add" | "block"; view?: "day" | "week" }
): Promise<void> {
  await page.locator(`.${view}-slot[data-slot="${slot}"][data-slot-groomer="${groomerId}"]`).click();
  await expect(page.getByTestId("slot-menu")).toBeVisible();
  await page.getByTestId(action === "add" ? "slot-menu-add" : "slot-menu-block").click();
}

/**
 * Choose a client by id and wait for their record to load.
 *
 * A client with exactly one pet has that pet selected for them, so callers that then call
 * {@link chooseBookingPet} are confirming an existing choice rather than making a new one.
 */
export async function chooseBookingClient(page: Page, customerId: string): Promise<void> {
  await page.locator(`[data-booking-client="${customerId}"]`).click();
  await expect(page.getByTestId("booking-client-name")).toBeVisible();
}

/**
 * Dismiss the required-vaccine prompt if it is showing, leaving the reminder unsent.
 *
 * The prompt only appears for a pet whose rabies record has already lapsed by the booked
 * date, so this is a no-op for the usual fixtures.
 */
export async function dismissVaccinationPrompt(page: Page): Promise<void> {
  const dialog = page.getByTestId("stacked-dialog");
  if (!await dialog.isVisible()) return;
  if (await page.locator("#stacked-dialog-title").textContent() !== "Required vaccine") return;
  await page.getByTestId("stacked-dialog-dismiss").click();
  await expect(dialog).toBeHidden();
}

/**
 * Select the pet through the picker and wait for its defaults to arrive.
 *
 * Confirming the picker always re-requests booking defaults, including when the pet was
 * already selected, so the wait is safe to set up before the click either way.
 */
export async function chooseBookingPet(page: Page, petId: string): Promise<void> {
  await dismissVaccinationPrompt(page);
  const defaults = page.waitForResponse((response) =>
    response.url().includes(`/api/pets/${petId}/booking-defaults`));
  await page.getByTestId("booking-add-pet").click();
  await page.locator(`input[name="bookingPet"][value="${petId}"]`).check();
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
  await defaults;
}

/**
 * Open every collapsed service section.
 *
 * The picker leads with one section open and folds the rest, so a service in any other
 * category is hidden from the accessibility tree until its section is expanded. Tests
 * expand the same way a person does rather than reaching past the collapsing.
 */
export async function expandBookingServices(page: Page): Promise<void> {
  // Iterate the sections, not the closed ones: a `:not([open])` list re-resolves after every
  // click, so the second click would be looking for an index that no longer exists.
  const sections = page.locator("#appointment-service-options .service-section");
  for (let index = 0; index < await sections.count(); index += 1) {
    const section = sections.nth(index);
    if (await section.getAttribute("open") === null) await section.locator("summary").click();
  }
}

/** Fill the appointment side of the workspace without submitting it. */
export async function fillBooking(
  page: Page,
  { employeeId, service = /Full Groom/, startAt }:
    { employeeId: string; service?: RegExp | string; startAt: string }
): Promise<void> {
  await page.locator('#booking-dialog select[name="employeeId"]').selectOption(employeeId);
  await expandBookingServices(page);
  await page.getByRole("checkbox", { name: service }).setChecked(true);
  await page.locator('#booking-dialog [name="startAt"]').fill(startAt);
}

/** Submit the workspace. Callers assert on the outcome themselves. */
export async function submitBooking(page: Page): Promise<void> {
  await page.getByTestId("booking-submit").scrollIntoViewIfNeeded();
  await page.getByTestId("booking-submit").click();
}

/** The whole happy path: open, choose client and pet, fill, submit. */
export async function bookAppointment(
  page: Page,
  { customerId, petId, employeeId, service, startAt }:
    { customerId: string; petId: string; employeeId: string; service?: RegExp | string; startAt: string }
): Promise<void> {
  await openBooking(page);
  await chooseBookingClient(page, customerId);
  await chooseBookingPet(page, petId);
  await fillBooking(page, service === undefined
    ? { employeeId, startAt }
    : { employeeId, service, startAt });
  await submitBooking(page);
}
