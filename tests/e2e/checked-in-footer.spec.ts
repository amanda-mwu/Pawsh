import { test, expect, login, createAppointment, createMember, password } from "./fixtures/tenant.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * WHAT A COUNTER DOES WITH A PET THAT IS IN THE SALON.
 *
 * Three things, and they are three different questions: record what happened (the service note),
 * say the work is finished (Ready for Pickup), and take the money (Take Payment). None of them
 * implies another. A visit may be paid for at drop-off and handed back an hour later; it may be
 * handed back and settled next week; the note may be corrected after both.
 *
 * WHY THIS IS A BROWSER SPEC. What the footer and the note block DRAW is held deterministically in
 * `tests/ui/checkout-eligibility.test.ts` and `tests/ui/appointment-dominant-slot.test.ts`, which
 * run the real `derive()` and the real markup. What cannot be asserted there is the reason this
 * walk exists:
 *
 *   THE SERVER KEEPS WHAT WAS SAVED, read back off the API and off a reopened surface rather than
 *       off the screen that wrote it. Human QA typed a service note, pressed the block's own Add
 *       again because it was the control beside the words, and nothing persisted - the only
 *       commit was a footer Save a screen away. The note has its own Save inside its block now,
 *       and "it is there when the visit is opened again" is the whole claim.
 *   A REFUSED SAVE LOSES NOTHING. The claim is about text still being in a control after a
 *       request failed, which only a real page can hold.
 *   A COMPLETED VISIT STILL TAKES THE NOTE. Rocky's note vanished the moment Ready for Pickup was
 *       pressed. The server accepts `completed` on the operations route now, and the block offers
 *       Edit there; the write is asserted end to end.
 *
 * NOT IN SCOPE and deliberately untouched: the checkout workspace, client credit, and the
 * document rules. This walk presses the footer and the note block.
 */

const GROOMER_PRESET = [
  "calendar.view", "appointments.view", "pets.view", "pets.care.view",
  "operations.check_in", "operations.perform_service", "operations.complete",
  "appointments.edit", "calendar.blocks_create", "calendar.blocks_edit"
];

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");
const ready = (page: Page): Locator => detail(page).getByTestId("appointment-ready");
const noteEdit = (page: Page): Locator => detail(page).getByTestId("appointment-service-note-edit");
const noteField = (page: Page): Locator => detail(page).getByTestId("appointment-service-note-input");
const noteSave = (page: Page): Locator => detail(page).getByTestId("appointment-service-note-save");
const noteText = (page: Page): Locator => detail(page).getByTestId("appointment-service-note");

async function checkInAppointment(api: APIRequestContext, tenant: { locationId: string }) {
  const appointment = await createAppointment(api, tenant as never);
  const response = await api.post(`/api/appointments/${appointment.id}/transition`, {
    data: { status: "checked_in", version: appointment.version }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { ...appointment, version: ((await response.json()) as { version: number }).version };
}

/** What the server says about the visit, which is the only authority on any of it. */
async function visit(api: APIRequestContext, appointmentId: string): Promise<{
  status: string; operationalNotes: string | null; invoiceId: string | null;
}> {
  const response = await api.get(`/api/appointments/${appointmentId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as {
    status: string; operationalNotes: string | null; invoiceId: string | null;
  };
  return {
    status: payload.status, operationalNotes: payload.operationalNotes,
    invoiceId: payload.invoiceId ?? null
  };
}

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

/** Close the surface and open the same visit again, so what is read is what was stored. */
async function reopenDetail(page: Page, appointmentId: string): Promise<void> {
  await detail(page).locator("[data-surface-close]").click();
  await expect(detail(page)).toBeHidden();
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

test("Add opens the service note's own editor, its Save persists, and the note is there on reopen",
  async ({ page, request, tenant }) => {
    const appointment = await checkInAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    // EMPTY -> ADD. No standing field: the block offers Add and draws the box only when pressed,
    // with the caret in it and Save and Cancel beside it. There is no footer Save at all.
    await expect(noteEdit(page)).toHaveText("Add");
    await expect(noteField(page)).toHaveCount(0);
    await expect(detail(page).getByTestId("appointment-save")).toHaveCount(0);
    await noteEdit(page).click();
    await expect(noteField(page)).toBeFocused();
    await expect(noteSave(page)).toBeVisible();
    await expect(detail(page).getByTestId("appointment-service-note-cancel")).toBeVisible();

    const typed = "Matted behind both ears; clipped short with the owner's say-so.";
    await noteField(page).fill(typed);
    await noteSave(page).click();

    // Saved: the block reads as text again, the heading offers Edit, and the server holds it.
    // READ MODE, NOT EDIT MODE: the field is gone until Edit is pressed. `saveServiceNote` goes on
    // to `refresh()` and `reload()` the whole surface after the save, and the redraw must seat
    // the editor shut - human QA reported a held note opening in edit mode.
    await expect(noteText(page)).toHaveText(typed);
    await expect(noteEdit(page)).toHaveText("Edit");
    await expect(noteField(page)).toHaveCount(0);
    await expect(noteSave(page)).toHaveCount(0);
    expect((await visit(request, appointment.id)).operationalNotes).toBe(typed);

    // REOPENED. The proof human QA needed: the note is on the visit, not only on the screen that
    // wrote it. And again in read mode: a fresh open of a visit that holds a note draws the note,
    // Edit, and no field.
    await reopenDetail(page, appointment.id);
    await expect(noteText(page)).toHaveText(typed);
    await expect(noteEdit(page)).toHaveText("Edit");
    await expect(noteField(page)).toHaveCount(0);

    // EDIT. Opens with what is held, saves the correction, and the correction is what comes back.
    await noteEdit(page).click();
    await expect(noteField(page)).toHaveValue(typed);
    await noteField(page).fill(`${typed} Nails done.`);
    await noteSave(page).click();
    await expect(noteText(page)).toHaveText(`${typed} Nails done.`);
    await reopenDetail(page, appointment.id);
    await expect(noteText(page)).toHaveText(`${typed} Nails done.`);
    expect((await visit(request, appointment.id)).operationalNotes).toBe(`${typed} Nails done.`);
  });

test("a visit that already holds a service note opens in read mode, for the owner, with Edit on the heading",
  async ({ page, request, tenant }) => {
    // Rocky, as human QA found him: checked in, a note already on the row, opened by the owner.
    // The block is text with Edit beside it; the editor appears only when Edit is pressed, and
    // Cancel puts it away again. This is the shape the block had before it became an editor of
    // its own - a standing textarea for anybody who could write it - and it must not come back.
    const appointment = await checkInAppointment(request, tenant);
    const held = "Nervous around the paws; nails done with the owner holding him.";
    const written = await request.patch(`/api/appointments/${appointment.id}/operations`, {
      data: { operationalNotes: held, version: appointment.version }
    });
    expect(written.ok(), await written.text()).toBeTruthy();
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    await expect(noteText(page)).toHaveText(held);
    await expect(noteEdit(page)).toHaveText("Edit");
    await expect(noteEdit(page)).toBeEnabled();
    await expect(noteField(page)).toHaveCount(0);
    await expect(noteSave(page)).toHaveCount(0);
    // The X has focus on open - not the note's editor, and not its Edit.
    await expect(detail(page).locator("[data-surface-close]")).toBeFocused();

    await noteEdit(page).click();
    await expect(noteField(page)).toHaveValue(held);
    await detail(page).getByTestId("appointment-service-note-cancel").click();
    await expect(noteField(page)).toHaveCount(0);
    await expect(noteText(page)).toHaveText(held);
    expect((await visit(request, appointment.id)).operationalNotes).toBe(held);
  });

test("Cancel gives the note back and writes nothing", async ({ page, request, tenant }) => {
  const appointment = await checkInAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await openDetail(page, appointment.id);

  await noteEdit(page).click();
  await noteField(page).fill("Half a thought.");
  await detail(page).getByTestId("appointment-service-note-cancel").click();
  await expect(noteField(page)).toHaveCount(0);
  await expect(detail(page).getByTestId("appointment-note")).toContainText("No service note.");
  await expect(noteEdit(page)).toHaveText("Add");
  expect((await visit(request, appointment.id)).operationalNotes).toBeNull();
});

test("a refused save keeps the operator's words on the screen", async ({ page, request, tenant }) => {
  const appointment = await checkInAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await openDetail(page, appointment.id);

  await noteEdit(page).click();
  // Somebody else writes to the appointment while this editor is open, so the version it opened
  // with goes stale and the save it is about to send is refused.
  const edited = await request.patch(`/api/appointments/${appointment.id}`, {
    data: { notes: "Owner rang about the ears" }
  });
  expect(edited.ok(), await edited.text()).toBeTruthy();

  const typed = "Nails done, ears flushed, second bath needed next time.";
  await noteField(page).fill(typed);
  await noteSave(page).click();

  // NOTHING IS WRITTEN AND NOTHING IS LOST. The row moved under the editor, so the refusal is
  // presented as a conflict: what is saved now beside what was typed, Save withdrawn in favour of
  // the two explicit choices, and the words still in the box.
  await expect(noteField(page)).toHaveValue(typed);
  const conflict = detail(page).getByTestId("appointment-service-note-conflict");
  await expect(conflict).toBeVisible();
  await expect(conflict.getByTestId("appointment-service-note-conflict-current")).toHaveText("No service note.");
  await expect(noteSave(page)).toHaveCount(0);
  expect((await visit(request, appointment.id)).operationalNotes).toBeNull();

  // KEEP MY VERSION re-sends against the row as it stands now, and this time it is written.
  await conflict.getByTestId("appointment-service-note-conflict-keep").click();
  await expect(noteText(page)).toHaveText(typed);
  expect((await visit(request, appointment.id)).operationalNotes).toBe(typed);
});

test("a completed visit still takes the service note, and the edit persists",
  async ({ page, request, tenant }) => {
    // BACKEND-DEPENDENT: `PATCH /api/appointments/:id/operations` must accept `completed`.
    const appointment = await checkInAppointment(request, tenant);
    const done = await request.post(`/api/appointments/${appointment.id}/transition`, {
      data: { status: "completed", version: appointment.version }
    });
    expect(done.ok(), await done.text()).toBeTruthy();
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    await expect(noteEdit(page)).toHaveText("Add");
    await expect(noteEdit(page)).toBeEnabled();
    await noteEdit(page).click();
    await noteField(page).fill("Written up after the pet went home.");
    await noteSave(page).click();
    await expect(noteText(page)).toHaveText("Written up after the pet went home.");
    await reopenDetail(page, appointment.id);
    await expect(noteText(page)).toHaveText("Written up after the pet went home.");
    expect((await visit(request, appointment.id)).operationalNotes).toBe("Written up after the pet went home.");
  });

test("a groomer edits the note on their own completed visit", async ({ page, request, tenant }) => {
  // BACKEND-DEPENDENT: needs `employeeId` on `GET /api/me` (the member is linked to the fixture
  // employee) and `completed` accepted by the operations route.
  const appointment = await checkInAppointment(request, tenant);
  const done = await request.post(`/api/appointments/${appointment.id}/transition`, {
    data: { status: "completed", version: appointment.version }
  });
  expect(done.ok(), await done.text()).toBeTruthy();
  const member = await createMember(request, `grace+${tenant.runId}@pawsh-test.example`, GROOMER_PRESET);
  const linked = await request.put(`/api/employees/${tenant.employeeId}`, {
    data: { membershipId: member.membershipId }
  });
  expect(linked.ok(), await linked.text()).toBeTruthy();
  await login(page, member.email, password);
  await openDetail(page, appointment.id);

  await expect(noteEdit(page)).toBeEnabled();
  await noteEdit(page).click();
  await noteField(page).fill("Rocky did well; tender on the left hip.");
  await noteSave(page).click();
  await expect(noteText(page)).toHaveText("Rocky did well; tender on the left hip.");
  await reopenDetail(page, appointment.id);
  await expect(noteText(page)).toHaveText("Rocky did well; tender on the left hip.");
  expect((await visit(request, appointment.id)).operationalNotes).toBe("Rocky did well; tender on the left hip.");
});

test("Ready for Pickup finishes the work, touches no money, and moves Print Ticket into the lead zone",
  async ({ page, request, tenant }) => {
    const appointment = await checkInAppointment(request, tenant);
    await login(page, tenant.ownerEmail);

    // Every request this page makes that could raise a bill or record a tender. The assertion is
    // that there were none: finishing the work is not a financial act.
    const money: string[] = [];
    page.on("request", (outgoing) => {
      if (outgoing.method() !== "POST") return;
      const path = new URL(outgoing.url()).pathname;
      if (/\/checkout$/u.test(path) || /\/payments$/u.test(path)) money.push(path);
    });

    await openDetail(page, appointment.id);
    await expect(ready(page)).toBeVisible();
    // Secondary, always: money outranks it, and there is exactly one primary on this footer.
    await expect(ready(page)).toHaveClass(/secondary/u);
    await expect(detail(page).locator("footer .primary")).toHaveCount(1);
    // While the visit is still moving the sheet is a utility.
    await expect(detail(page).locator(".surface-foot-utility [data-testid='appointment-ticket']")).toHaveCount(1);
    await expect(detail(page).locator(".surface-foot-lead [data-testid='appointment-ticket']")).toHaveCount(0);

    await ready(page).click();

    // THE SERVER'S ANSWER, which is the only one that counts. `completed` is the existing status:
    // no new state was invented for this button.
    await expect(async () => {
      expect((await visit(request, appointment.id)).status).toBe("completed");
    }).toPass();
    expect(money).toEqual([]);
    expect((await visit(request, appointment.id)).invoiceId).toBeNull();

    // And the button is gone from the visit it has already finished, while the sheet has moved
    // to the lead zone - still exactly one Print Ticket, beside Take Payment.
    await expect(ready(page)).toHaveCount(0);
    await expect(detail(page).getByTestId("appointment-ticket")).toHaveCount(1);
    await expect(detail(page).locator(".surface-foot-lead [data-testid='appointment-ticket']")).toHaveCount(1);
    await expect(detail(page).locator(".surface-foot-utility [data-testid='appointment-ticket']")).toHaveCount(0);
    await expect(detail(page).getByTestId("appointment-take-payment")).toHaveClass(/primary/u);
    await expect(detail(page).locator("footer .primary")).toHaveCount(1);
  });
