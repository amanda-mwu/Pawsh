import {
  test,
  expect,
  login,
  createAppointment,
  prepareReceipt,
  createMember,
  ownerPermissions
} from "./fixtures/tenant.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * Editing `appointments.notes` from the appointment surface.
 *
 * THE NOTE IS PART OF THE EDITABLE RECORD. It was write-once for want of a route rather than by
 * decision, and `PATCH /api/appointments/:id` closes that with no status precondition and no
 * invoice precondition — so the visit these specs edit is deliberately the hardest case there is:
 * completed, invoiced and paid in full. Correcting the spelling of a note must not mean cancelling
 * and rebooking a settled visit.
 *
 * IT IS NOT THE SERVICE NOTE. `operational_notes` keeps its own route, its own permission
 * (`operations.perform_service`) and its own status window, and the surface keeps drawing it as a
 * second, separate control with the footer Save it has always had. Every spec below asserts on the
 * appointment note's own controls, which live inside its own part of the note block.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail");
const recordNote = (page: Page): Locator => page.getByTestId("appointment-record-note");

async function openFromCalendar(page: Page, appointmentId: string): Promise<Locator> {
  await page.getByTestId("nav-calendar").click();
  // The calendar renders twice on entry — the week, then the month it backfills — so the card is
  // replaced under anything that clicked the first copy.
  await page.waitForLoadState("networkidle");
  const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
  await card.locator(".calendar-open").first().click();
  await expect(detail(page)).toBeVisible();
  return card;
}

/** Writes the note from outside the browser, the way a second operator would. */
async function writeNoteElsewhere(
  api: APIRequestContext,
  appointmentId: string,
  notes: string
): Promise<void> {
  const current = await api.get(`/api/appointments/${appointmentId}`);
  expect(current.status(), await current.text()).toBe(200);
  const { version } = (await current.json()) as { version: number };
  const response = await api.patch(`/api/appointments/${appointmentId}`, { data: { notes, version } });
  expect(response.status(), await response.text()).toBe(200);
}

test("a settled visit's note is written, read back, carried onto the Ticket and cleared", async ({
  page,
  request,
  tenant
}) => {
  // Completed, invoiced and paid to a zero balance. Nothing about this visit can move any more,
  // and the note on it still can.
  const { appointment } = await prepareReceipt(request, tenant);
  await login(page, tenant.ownerEmail);
  await openFromCalendar(page, appointment.id);

  // The read state: no note, and one control to add one. The service note is a different field
  // and its window closed when the visit completed, so it has no field here at all.
  await expect(recordNote(page)).toContainText("No appointment note.");
  await expect(recordNote(page).locator("textarea")).toHaveCount(0);
  await expect(page.getByTestId("appointment-service-note")).toHaveCount(0);
  await expect(page.getByTestId("appointment-note-input")).toHaveCount(0);
  await expect(page.getByTestId("appointment-save")).toHaveCount(0);

  await page.getByTestId("appointment-note-edit").click();
  const field = page.getByTestId("appointment-note-record-input");
  // Opening the editor puts the caret in it, so the correction can be typed without a second click.
  await expect(field).toBeFocused();
  await field.fill("Owner collecting at 4pm sharp.");
  await page.getByTestId("appointment-note-save").click();

  // Back to text, from the row the server answered with rather than from what was typed.
  await expect(recordNote(page).getByTestId("appointment-booking-note"))
    .toHaveText("Owner collecting at 4pm sharp.");
  await expect(page.getByTestId("appointment-note-record-input")).toHaveCount(0);
  await expect(page.getByTestId("appointment-note-edit")).toBeFocused();

  // Closed and opened again: the value is the server's, not a redraw of what the page remembered.
  await page.keyboard.press("Escape");
  await expect(detail(page)).toBeHidden();
  await openFromCalendar(page, appointment.id);
  await expect(recordNote(page).getByTestId("appointment-booking-note"))
    .toHaveText("Owner collecting at 4pm sharp.");

  // The Ticket renders the live projection, so the corrected note is on the next sheet printed
  // without the Ticket having a writer of its own. It stays a document: no field on it.
  await page.getByTestId("appointment-ticket-print").click();
  const ticket = page.getByTestId("ticket-surface");
  await expect(ticket).toBeVisible();
  await expect(ticket.getByTestId("ticket-note-appointment").locator("td"))
    .toHaveText(["Appointment note", "Owner collecting at 4pm sharp."]);
  await expect(ticket.locator("textarea")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(ticket).toBeHidden();

  // Emptying the box CLEARS the note rather than storing a blank one, and the surface says so in
  // the same words it used before anything was ever written.
  await page.getByTestId("appointment-note-edit").click();
  await page.getByTestId("appointment-note-record-input").fill("");
  await page.getByTestId("appointment-note-save").click();
  await expect(recordNote(page)).toContainText("No appointment note.");
  await expect(recordNote(page).getByTestId("appointment-booking-note")).toHaveCount(0);

  const stored = await request.get(`/api/appointments/${appointment.id}`);
  expect(((await stored.json()) as { notes: string | null }).notes).toBeNull();
});

test("a note changed elsewhere refuses the save and lets the operator choose", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await writeNoteElsewhere(request, appointment.id, "Front desk: bring the harness.");
  await login(page, tenant.ownerEmail);
  await openFromCalendar(page, appointment.id);

  await page.getByTestId("appointment-note-edit").click();
  const field = page.getByTestId("appointment-note-record-input");
  await field.fill("Front desk: bring the harness and the muzzle.");

  // Somebody else corrects the same note while this box is open. The save below carries the
  // version this editor opened with, so the server refuses it rather than losing their edit.
  await writeNoteElsewhere(request, appointment.id, "Front desk: harness is in the van.");
  await page.getByTestId("appointment-note-save").click();

  const conflict = page.getByTestId("appointment-note-conflict");
  await expect(conflict).toBeVisible();
  await expect(page.getByTestId("appointment-note-conflict-current"))
    .toHaveText("Front desk: harness is in the van.");
  // NOTHING IS MERGED AND NOTHING IS DISCARDED: what the operator typed is still in the box, and
  // the saved note is quoted beside it.
  await expect(field).toHaveValue("Front desk: bring the harness and the muzzle.");
  // The plain Save is withdrawn while the refusal stands, so there is exactly one button that
  // writes and it says which version it writes.
  await expect(page.getByTestId("appointment-note-save")).toHaveCount(0);

  // Taking the saved note puts it in the box and leaves the operator editing it — it does not save.
  await page.getByTestId("appointment-note-conflict-take").click();
  await expect(conflict).toHaveCount(0);
  await expect(page.getByTestId("appointment-note-save")).toBeVisible();
  await expect(field).toHaveValue("Front desk: harness is in the van.");

  // Refused a second time, to prove the refusal is the rule rather than a one-shot.
  await writeNoteElsewhere(request, appointment.id, "Front desk: harness is at reception.");
  await field.fill("Front desk: harness is in the van, keys with Grace.");
  await page.getByTestId("appointment-note-save").click();
  await expect(page.getByTestId("appointment-note-conflict-current"))
    .toHaveText("Front desk: harness is at reception.");

  // Keeping the operator's version retries against the version just read back, and wins.
  await page.getByTestId("appointment-note-conflict-keep").click();
  await expect(recordNote(page).getByTestId("appointment-booking-note"))
    .toHaveText("Front desk: harness is in the van, keys with Grace.");

  const stored = await request.get(`/api/appointments/${appointment.id}`);
  expect(((await stored.json()) as { notes: string | null }).notes)
    .toBe("Front desk: harness is in the van, keys with Grace.");
});

test("without appointments.edit the note is text and there is nothing to press", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await writeNoteElsewhere(request, appointment.id, "Nervous around clippers.");
  // A groomer reads the note and does not edit it. Withheld rather than offered and refused —
  // the rule the rest of this surface already follows.
  const member = await createMember(
    request,
    `no-appointment-edit-${tenant.runId}@pawsh-test.example`,
    ownerPermissions.filter((permission: string) => permission !== "appointments.edit")
  );
  await login(page, member.email);
  await openFromCalendar(page, appointment.id);

  await expect(recordNote(page).getByTestId("appointment-booking-note"))
    .toHaveText("Nervous around clippers.");
  await expect(page.getByTestId("appointment-note-edit")).toHaveCount(0);
  await expect(recordNote(page).locator("textarea")).toHaveCount(0);
  await expect(page.getByTestId("appointment-note-save")).toHaveCount(0);
});

test("a save that fails for any other reason keeps the box, the text and the operator's place", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, tenant.ownerEmail);
  await openFromCalendar(page, appointment.id);

  // The one mocked failure in this file. A refusal that is not a conflict has nothing to reconcile,
  // so it is reported where the operator is looking and the correction stays where they typed it —
  // a note lost to a dropped connection is a note somebody retypes from memory.
  await page.route(`**/api/appointments/${appointment.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Appointment not found" }) })
      : route.continue()
  );

  await page.getByTestId("appointment-note-edit").click();
  const field = page.getByTestId("appointment-note-record-input");
  await field.fill("Ring the bell twice — the buzzer is broken.");
  await page.getByTestId("appointment-note-save").click();

  await expect(page.getByTestId("appointment-note-error")).toHaveText("Appointment not found");
  await expect(field).toHaveValue("Ring the bell twice — the buzzer is broken.");
  await expect(field).toBeEnabled();
  await expect(page.getByTestId("appointment-note-save")).toBeEnabled();
  // Not a conflict: there is no second version to choose between.
  await expect(page.getByTestId("appointment-note-conflict")).toHaveCount(0);

  // And Cancel still gives the note back rather than leaving the surface stuck in a failed save.
  await page.getByTestId("appointment-note-cancel").click();
  await expect(recordNote(page)).toContainText("No appointment note.");
  await expect(page.getByTestId("appointment-note-error")).toHaveCount(0);
});

test("the two notes coexist: editing one never disturbs what is typed in the other", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  const checkedIn = await request.post(`/api/appointments/${appointment.id}/transition`, {
    data: { status: "checked_in", version: appointment.version }
  });
  expect(checkedIn.status(), await checkedIn.text()).toBe(200);
  await login(page, tenant.ownerEmail);
  await openFromCalendar(page, appointment.id);

  // Both are writable at once here, and only here: the service note's window is open because the
  // dog is checked in, and the appointment note's is always open.
  const serviceField = page.getByTestId("appointment-note-input");
  await serviceField.fill("Ears looked sore on arrival.");

  await page.getByTestId("appointment-note-edit").click();
  await page.getByTestId("appointment-note-record-input").fill("Client asked for a shorter body.");
  // The appointment note redraws its own part of the block, so an unsaved service note is still
  // there — losing it would be the worst kind of quiet regression.
  await expect(serviceField).toHaveValue("Ears looked sore on arrival.");

  await page.getByTestId("appointment-note-save").click();
  await expect(recordNote(page).getByTestId("appointment-booking-note"))
    .toHaveText("Client asked for a shorter body.");
  await expect(serviceField).toHaveValue("Ears looked sore on arrival.");

  // And the footer Save still writes the service note and only the service note.
  await page.getByTestId("appointment-save").click();
  await expect(page.locator("#toast")).toContainText("Service note saved");
  const stored = await (await request.get(`/api/appointments/${appointment.id}`)).json();
  expect(stored.operationalNotes).toBe("Ears looked sore on arrival.");
  expect(stored.notes).toBe("Client asked for a shorter body.");
});
