import { createAppointment, createMember, expect, login, test, type TenantFixture } from "./fixtures/tenant.js";
import { createDatabase } from "../../src/db/client.js";
import { permissionPresets } from "@pawsh/domain";
import { prefLocalDate } from "./helpers/calendar.js";
import { expectCriticalTarget } from "./helpers/responsive.js";
import { contrastRatio, swatchMark } from "./helpers/contrast.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * THE BLOCK TIME DIALOG.
 *
 * `blocked-time-visibility.spec.ts` is about the band being DRAWN where the scheduler refuses. This
 * file is about the band being OPENABLE, and about the four things that are easy to get wrong once
 * it is:
 *
 *   1. The band must become a control WITHOUT becoming a card. It is still not draggable and still
 *      not a drop target, and the slot underneath it must still take a drop and still be refused.
 *   2. The three ways out - X, Cancel and Escape - must send NOTHING. Every one of them is asserted
 *      against an intercepted request count rather than against a hopeful screenshot, because a
 *      stray mutation on dismiss is invisible until somebody's Thursday has moved.
 *   3. The dialog's X must not be the document-wide `.close`. `public/app.js` binds every `.close`
 *      in the document to `$("#modal").close()`, so a `.close` here would close the wrong dialog -
 *      and the regression that would prove it is the OTHER dialogs still closing, which is asserted
 *      below rather than assumed.
 *   4. `version` has to travel on both mutations, and a 409 has to reach the operator as a stale
 *      copy rather than as a silent retry.
 */

async function createBlock(
  request: APIRequestContext,
  tenant: TenantFixture,
  options: { localStart: string; localEnd: string; reason: string; colorSlot?: number; employeeId?: string }
): Promise<{ id: string; version: number }> {
  const response = await request.post("/api/blocked-times", {
    data: {
      employeeId: options.employeeId ?? tenant.employeeId,
      locationId: tenant.locationId,
      localStart: options.localStart,
      localEnd: options.localEnd,
      reason: options.reason,
      ...(options.colorSlot === undefined ? {} : { colorSlot: options.colorSlot }),
      expectedLocationVersion: tenant.locationVersion
    }
  });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as { id: string; version: number };
}

async function readBlocks(
  request: APIRequestContext,
  tenant: TenantFixture
): Promise<Array<Record<string, unknown>>> {
  const response = await request.get(`/api/blocked-times?localDate=${tenant.anchor}&days=1`);
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as Array<Record<string, unknown>>;
}

async function openCalendar(page: Page): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

async function openBlock(page: Page): Promise<void> {
  await page.getByTestId("calendar-block").first().click();
  await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
}

/**
 * One colour swatch, driven the way `staff.spec.ts` drives the same picker.
 *
 * The radio itself is a 1px clipped input under its own dot - which is how the group buys arrow-key
 * roving and a single tab stop for free - so it is the LABEL that gets clicked, exactly as a person
 * clicks it. "None" is excluded from the name filter because it is the one cell whose text does not
 * name a colour.
 */
function swatch(page: Page, name: string) {
  const picker = page.locator("#blocked-time-dialog");
  if (name === "None") return picker.locator(".staff-swatch.is-none");
  return picker.locator(".staff-swatch:not(.is-none)").filter({ hasText: new RegExp(`^${name}$`) });
}

/**
 * Counts every write this dialog is capable of making, for the tests that assert it made none.
 *
 * Counted at the route level rather than by watching the UI: the point of the dismissal tests is
 * that NOTHING left the browser, and a screen that looks unchanged is not evidence of that.
 */
function countBlockMutations(page: Page): { patch: number; delete: number } {
  const seen = { patch: 0, delete: 0 };
  page.on("request", (request) => {
    if (!/\/api\/blocked-times\//.test(request.url())) return;
    if (request.method() === "PATCH") seen.patch += 1;
    if (request.method() === "DELETE") seen.delete += 1;
  });
  return seen;
}

test("opens the block behind the band, with everything the block actually says",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T13:00`,
      reason: "Lunch", colorSlot: 5
    });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);

    // The band carries the colour, and carries it as CHROME. `data-block-slot` is what the palette
    // tokens hang off; the label is never recoloured, so the band keeps --ink text on its tint.
    const band = page.getByTestId("calendar-block");
    await expect(band).toHaveAttribute("data-block-slot", "5");
    // Still not a card, still not a slot - the two attributes the drag and the drop key off.
    // Draggable for an owner, who may move any block - and still never a drop target, never an
    // appointment. `tests/e2e/blocked-time-drag.spec.ts` walks the drag itself.
    expect(await band.getAttribute("data-draggable")).toBe("true");
    expect(await band.getAttribute("data-appointment-id")).toBeNull();
    expect(await band.getAttribute("data-slot")).toBeNull();

    await openBlock(page);
    // Opening lands on the first control that can be used, which for an ordinary block is Date.
    await expect(page.getByTestId("blocked-time-date")).toBeFocused();
    await expect(page.getByTestId("blocked-time-date")).toHaveValue(tenant.anchor);
    await expect(page.getByTestId("blocked-time-start")).toHaveValue("12:00");
    await expect(page.getByTestId("blocked-time-end")).toHaveValue("13:00");
    await expect(page.getByTestId("blocked-time-staff")).toHaveValue(tenant.employeeId);
    await expect(page.getByTestId("blocked-time-note")).toHaveValue("Lunch");
    // Slot 5 is Plum, by the one palette `Settings -> Staff` already names. The spoken line is what
    // makes the colour reachable without seeing it, which is why the swatch grid has one.
    await expect(page.getByTestId("blocked-time-colour-current")).toHaveText("Selected: Plum");
    await expect(swatch(page, "Plum").locator("input")).toBeChecked();
    // Ten named colours plus the unset option, and not one hex anywhere in the picker.
    await expect(page.locator("#blocked-time-dialog .staff-swatch")).toHaveCount(11);

    // Recurring is DRAWN AND SWITCHED OFF. Pawsh has no recurrence at all, so hiding the choice
    // would make the dialog look complete and leave the gap to be discovered.
    const recurring = page.getByRole("radio", { name: "Recurring" });
    await expect(recurring).toBeVisible();
    await expect(recurring).toBeDisabled();
    await expect(page.getByRole("radio", { name: "One time" })).toBeChecked();
    await expect(page.getByTestId("blocked-time-recurring-note"))
      .toContainText("Recurring blocks are not available");
  });

test("updates the block, and the band on the calendar follows it",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    const band = page.getByTestId("calendar-block");
    await expect(band).toHaveText("12:00 PM–12:30 PM · Lunch");
    // No colour yet, so no token attribute and the plain hatched band.
    expect(await band.getAttribute("data-block-slot")).toBeNull();

    await openBlock(page);
    await page.getByTestId("blocked-time-end").fill("13:30");
    await page.getByTestId("blocked-time-note").fill("Team meeting");
    await swatch(page, "Teal").click();
    await expect(page.getByTestId("blocked-time-colour-current")).toHaveText("Selected: Teal");
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();

    // The band re-renders from the projection the PATCH handed back - the new range, the new note
    // and the new colour, without a reload.
    await expect(band).toHaveText("12:00 PM–1:30 PM · Team meeting");
    await expect(band).toHaveAttribute("data-block-slot", "2");

    // And it is the row that changed, not just the pixels.
    const [stored] = await readBlocks(request, tenant);
    expect(stored!.scheduledLocalEnd).toBe(`${tenant.anchor}T13:30`);
    expect(stored!.reason).toBe("Team meeting");
    expect(stored!.colorSlot).toBe(2);
    expect(stored!.version).toBe(2);
  });

test("deletes the block, and the time it was holding books cleanly afterwards",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T13:00`, reason: "Lunch"
    });

    // The refusal FIRST, so the booking below is attributable to the delete rather than to a slot
    // that was always free. Visibility and enforcement have to agree in both directions.
    const blocked = await request.post("/api/appointments", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        locationId: tenant.locationId, customerId: tenant.customerId, petId: tenant.petId,
        employeeId: tenant.employeeId, serviceIds: [tenant.serviceId],
        localStart: `${tenant.anchor}T12:00`, expectedLocationVersion: tenant.locationVersion
      }
    });
    expect(blocked.status(), await blocked.text()).toBe(409);
    expect((await blocked.json()).code).toBe("TIME_BLOCKED");

    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await openBlock(page);
    await page.getByTestId("blocked-time-delete").click();
    // Deleting asks first, through the shared confirmation every destructive action here uses.
    await expect(page.getByTestId("blocked-time-delete-question")).toContainText("Lunch");
    await page.getByTestId("stacked-dialog-confirm").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    await expect(page.getByTestId("calendar-block")).toHaveCount(0);
    expect(await readBlocks(request, tenant)).toEqual([]);

    // The same slot, the same request, now accepted - the block is gone from the scheduler and not
    // only from the grid.
    const booked = await request.post("/api/appointments", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        locationId: tenant.locationId, customerId: tenant.customerId, petId: tenant.petId,
        employeeId: tenant.employeeId, serviceIds: [tenant.serviceId],
        localStart: `${tenant.anchor}T12:00`, expectedLocationVersion: tenant.locationVersion
      }
    });
    expect(booked.status(), await booked.text()).toBe(201);
  });

test("dismisses with X, Cancel and Escape without sending a single request",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    const mutations = countBlockMutations(page);
    await openCalendar(page);

    // Each of the three is exercised over a form that has been EDITED, because a dismissal that
    // discards nothing proves nothing: the risk being held down is a dialog that quietly saves.
    for (const dismiss of [
      async () => page.getByTestId("blocked-time-close").click(),
      async () => page.getByTestId("blocked-time-cancel").click(),
      async () => page.keyboard.press("Escape")
    ]) {
      await openBlock(page);
      await page.getByTestId("blocked-time-note").fill("Edited and thrown away");
      await page.getByTestId("blocked-time-end").fill("15:00");
      await swatch(page, "Clay").click();
      await dismiss();
      await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
      // The band is untouched by the discarded edit.
      await expect(page.getByTestId("calendar-block")).toHaveText("12:00 PM–12:30 PM · Lunch");
    }

    expect(mutations, "dismissing a dialog must never mutate").toEqual({ patch: 0, delete: 0 });

    // And the row itself, read straight from the API and then through a reload, is exactly as it
    // was created - version included, which is what a no-op PATCH would have moved.
    const [stored] = await readBlocks(request, tenant);
    expect(stored!.reason).toBe("Lunch");
    expect(stored!.scheduledLocalEnd).toBe(`${tenant.anchor}T12:30`);
    expect(stored!.colorSlot).toBeNull();
    expect(stored!.version).toBe(1);
    await page.reload();
    await openCalendar(page);
    await expect(page.getByTestId("calendar-block")).toHaveText("12:00 PM–12:30 PM · Lunch");
    expect(await page.getByTestId("calendar-block").getAttribute("data-block-slot")).toBeNull();
  });

/**
 * THE REGRESSION THIS SEAM MOST DESERVED TO CAUSE.
 *
 * `$$(".close").forEach(button => button.addEventListener("click", () => $("#modal").close()))`
 * runs once at load over the WHOLE document. A `.close` inside the Block Time dialog would have
 * been swept up by it and would have dismissed `#modal` instead - so the dialog's X is scoped
 * (`[data-blocked-time-close]`, bound to its own dialog) and uses no `.close` at all.
 *
 * The other half of that claim is that the dialogs which DO rely on the global handler still work,
 * which is what this exercises: the shared `#modal`'s own X and its Cancel, and the booking
 * workspace's separately-bound close, all after the Block Time dialog has been opened and closed.
 */
test("leaves the document-wide .close handler working for the dialogs that use it",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);

    // Open and close the new dialog first, so anything it does to the document has already happened.
    await openBlock(page);
    await page.getByTestId("blocked-time-close").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();

    // `#modal`, which the global handler exists for, reached the way an operator reaches it.
    const slot = page.locator(`[data-slot="${tenant.anchor}T15:00"][data-slot-groomer="${tenant.employeeId}"]`).first();
    await slot.scrollIntoViewIfNeeded();
    await slot.click();
    await page.getByTestId("slot-menu-block").click();
    await expect(page.getByTestId("modal")).toBeVisible();
    await page.locator("#modal .modal-head .close").click();
    await expect(page.getByTestId("modal")).toBeHidden();

    // Its Cancel is the same class and the same handler.
    await slot.click();
    await page.getByTestId("slot-menu-block").click();
    await expect(page.getByTestId("modal")).toBeVisible();
    await page.locator("#modal .modal-actions .close").click();
    await expect(page.getByTestId("modal")).toBeHidden();

    // A different dialog family with its own `.close`, to show the sweep did not merely survive in
    // the one place it is aimed at.
    await slot.click();
    await page.getByTestId("slot-menu-add").click();
    await expect(page.getByTestId("booking-dialog")).toBeVisible();
    await page.locator("#booking-dialog .close").first().click();
    await expect(page.getByTestId("booking-dialog")).toBeHidden();

    // And the Block Time dialog still opens afterwards, so none of the above closed IT either.
    await openBlock(page);
    await expect(page.getByTestId("blocked-time-note")).toHaveValue("Lunch");
  });

test("refuses a stale copy honestly instead of retrying over somebody else's edit",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const block = await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await openBlock(page);

    // Somebody else edits the same block while this dialog is open. The browser is now holding
    // version 1 of a row that is on version 2.
    const elsewhere = await request.patch(`/api/blocked-times/${block.id}`, {
      data: { version: block.version, reason: "Dentist" }
    });
    expect(elsewhere.status(), await elsewhere.text()).toBe(200);

    await page.getByTestId("blocked-time-note").fill("Staff meeting");
    await page.getByTestId("blocked-time-update").click();

    // The server's own sentence, in the dialog, and the dialog STAYS OPEN over the current row.
    await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
    await expect(page.getByTestId("blocked-time-error"))
      .toContainText("This block changed somewhere else");
    await expect(page.getByTestId("blocked-time-note")).toHaveValue("Dentist");

    // NOT RETRIED. The other edit is intact and the version moved exactly once - a silent retry
    // would have overwritten "Dentist" with "Staff meeting" and left version 3 behind.
    const [stored] = await readBlocks(request, tenant);
    expect(stored!.reason).toBe("Dentist");
    expect(stored!.version).toBe(2);

    // The refreshed form is usable: the same edit, composed against the current row, now lands.
    await page.getByTestId("blocked-time-note").fill("Staff meeting");
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    const [after] = await readBlocks(request, tenant);
    expect(after!.reason).toBe("Staff meeting");
    expect(after!.version).toBe(3);
  });

test("reads the dialog's times through the workspace's hour format", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await createBlock(request, tenant, {
    localStart: `${tenant.anchor}T14:00`, localEnd: `${tenant.anchor}T14:30`, reason: "Staff meeting"
  });
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  await openBlock(page);
  // The native date and time pickers lay themselves out in the BROWSER's locale, which nothing can
  // change. This line is the same block in the salon's own format, and it is the one an operator on
  // a 24-hour workspace can actually read.
  await expect(page.getByTestId("blocked-time-when")).toContainText("2:00 PM–2:30 PM");
  await page.getByTestId("blocked-time-cancel").click();

  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await page.locator("#settings-navigation").getByRole("button", { name: "Business", exact: true }).click();
  await page.getByTestId("business-hour-format").selectOption("24");
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");
  await page.reload();
  await openCalendar(page);
  await openBlock(page);
  await expect(page.getByTestId("blocked-time-when")).toContainText("14:00–14:30");
  await expect(page.getByTestId("blocked-time-when")).not.toContainText(/[AP]M/);
});

/**
 * A DERIVED `Created` HAS TO LOOK DIFFERENT FROM AN OBSERVED ONE.
 *
 * The activity route reconstructs a Created entry, at read time, for blocks that predate the audit
 * wiring - from `blocked_times.created_by` and `created_at`, carrying no field values at all. The
 * reader has to be able to tell that from an entry the log actually observed, so the two are
 * asserted side by side in one feed: this block gets a real update event AND a derived create,
 * which is reached the only honest way there is - by removing the create event the route wrote, so
 * the row genuinely has none.
 */
test("distinguishes a reconstructed Created entry from the events the log observed",
  async ({ page, request, tenant }) => {
    test.skip(!process.env.DATABASE_URL,
      "needs this run's own database to remove the create event the route wrote");
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const block = await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    const db = createDatabase({ DATABASE_URL: process.env.DATABASE_URL! });
    try {
      const removed = await db`
        delete from audit_events
        where resource_type='blocked_time' and resource_id=${block.id} and action='blocked_time.create'
        returning id`;
      expect(removed.length, "the create event being removed has to exist").toBe(1);
    } finally {
      await db.end({ timeout: 5 });
    }

    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await openBlock(page);
    // One real event, made through this dialog.
    await page.getByTestId("blocked-time-note").fill("Dentist");
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    await openBlock(page);

    const entries = page.getByTestId("blocked-time-activity-item");
    await expect(entries).toHaveCount(2);
    // Newest first: the observed update, then the reconstructed create.
    const observed = entries.nth(0), derived = entries.nth(1);
    await expect(observed).toHaveAttribute("data-derived", "false");
    await expect(observed).toContainText("Updated");
    // A real entry carries the change it observed, as from -> to.
    await expect(observed).toContainText("Lunch");
    await expect(observed).toContainText("Dentist");
    await expect(observed.getByTestId("blocked-time-activity-derived-tag")).toHaveCount(0);

    await expect(derived).toHaveAttribute("data-derived", "true");
    await expect(derived).toContainText("Created");
    // VISIBLY marked, and the mark says what it means rather than being a colour to be inferred.
    await expect(derived.getByTestId("blocked-time-activity-derived-tag")).toBeVisible();
    await expect(derived).toContainText("older than the activity log");
    // It carries no field values, because the columns it was rebuilt from attest none.
    await expect(derived).not.toContainText("Lunch");
  });

/**
 * READING IS `appointments.view`; CHANGING IS `calendar.blocks_edit`.
 *
 * A Groomer can see the calendar and therefore the block, and can read its history - which is why
 * Update and Delete are DISABLED rather than removed. Removing them would answer "why can I not
 * edit this?" with nothing at all, which is the house convention this follows.
 */
test("shows a member without calendar.blocks_edit a readable block and no way to change it",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    // WITHOUT THE KEY, BY NAME. The Groomer preset grants `calendar.blocks_edit` for the
    // groomer's own blocks now, so the role this test is about is spelled out rather than read
    // off the preset: a member who may look at the calendar and may not change any block.
    const groomer = await createMember(request, `groomer+${tenant.runId}@pawsh-test.example`,
      permissionPresets.groomer!.filter((key) => key !== "calendar.blocks_edit"));

    await login(page, groomer.email);
    const mutations = countBlockMutations(page);
    await openCalendar(page);
    await openBlock(page);

    // Readable - and opening lands on the × rather than silently on nothing, because `.focus()` on
    // a disabled field is a no-op and every field here is disabled.
    await expect(page.getByTestId("blocked-time-close")).toBeFocused();
    await expect(page.getByTestId("blocked-time-note")).toHaveValue("Lunch");
    await expect(page.getByTestId("blocked-time-when")).toContainText("12:00 PM–12:30 PM");
    // The history is gated on `appointments.view`, which a Groomer has.
    await expect(page.getByTestId("blocked-time-activity-item").first()).toBeVisible();

    // Disabled, not hidden, and the fields with them.
    await expect(page.getByTestId("blocked-time-update")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-delete")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-date")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-note")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-staff")).toBeDisabled();
    await expect(swatch(page, "Plum").locator("input")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-locked"))
      .toContainText("You do not have permission to change blocked time");

    // Dismissing still costs nothing, and nothing was attempted on the way in.
    await page.getByTestId("blocked-time-cancel").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    expect(mutations).toEqual({ patch: 0, delete: 0 });
  });

test("shows a groomer another staff member's block read-only, saying whose calendar it is on rather than naming a key",
  async ({ page, request, tenant }) => {
    // The block is Grace's. This member holds `calendar.blocks_edit` but no employee record and
    // no `appointments.edit_all_staff`, so the block is not theirs: every field is read-only and
    // the sentence says so about a BLOCK - not the appointment surface's "this appointment is
    // assigned to another groomer", which the drawer borrowed for a while and which read as
    // nonsense over Lunch. A session linked to Grace's own record sees the same drawer editable -
    // `tests/e2e/groomer-scope.spec.ts` walks that half.
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    const groomer = await createMember(request, `other-groomer+${tenant.runId}@pawsh-test.example`,
      [...new Set([...permissionPresets.groomer!, "calendar.blocks_edit", "calendar.blocks_create"])]);

    await login(page, groomer.email);
    const mutations = countBlockMutations(page);
    await openCalendar(page);
    await openBlock(page);

    await expect(page.getByTestId("blocked-time-update")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-update")).toHaveAttribute("title", "This blocked time is on another groomer's calendar");
    await expect(page.getByTestId("blocked-time-delete")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-delete")).toHaveAttribute("title", "This blocked time is on another groomer's calendar");
    await expect(page.getByTestId("blocked-time-date")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-locked")).toContainText("This blocked time is on another groomer's calendar. Everything here is read-only.");
    await expect(page.getByTestId("blocked-time-locked")).not.toContainText("edit_all_staff");
    await expect(page.getByTestId("blocked-time-locked")).not.toContainText("appointment");
    // And the band itself is not draggable for this session.
    await expect(page.getByTestId("calendar-block").first()).not.toHaveAttribute("data-draggable", "true");

    await page.getByTestId("blocked-time-cancel").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    expect(mutations).toEqual({ patch: 0, delete: 0 });
  });

/* == THE FINAL POLISH SEAM ======================================================================
 *
 * Everything above is about the dialog existing and being safe. Everything below is about the four
 * things that were still missing once it did, and each is asserted at the seam where it could
 * silently be wrong rather than at the screen where it would look right:
 *
 *   NOTE CLEARING, ON THE WIRE. `reason` now has four wire forms and only one of them clears, so
 *   these tests read the PATCH BODY. A client that sent `""` would get a 400 and a client that sent
 *   nothing would leave the note in place; both look identical to a screenshot taken a moment
 *   before the assertion, and neither looks like the `null` that is correct.
 *
 *   THE CREATE DIALOG'S COLOUR, AS A SLOT. Colour used to be create-then-edit. What matters beyond
 *   "it saves" is that the palette is not forked - eleven cells, the same names, the same spoken
 *   line the drawer has - and that what travels is an integer index rather than a hex, because a
 *   hex on the wire turns a restyle into a data migration.
 *
 *   THE DELETE CONFIRMATION'S DISMISSALS, AGAINST AN INTERCEPTED COUNT. "The block is still there"
 *   is not evidence that no DELETE was sent; it is evidence that none SUCCEEDED.
 *
 *   THE SIX REFRESHES, IN ONE PAGE THAT IS NEVER RELOADED. The window global set at the start is
 *   what makes that a fact rather than an intention: a reload destroys it, so an assertion that
 *   reads it back at the end cannot pass if the page went round again.
 */

/** Every PATCH body this dialog sends, so what went on the wire is read rather than inferred. */
function recordBlockPatches(page: Page): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  page.on("request", (sent) => {
    if (sent.method() !== "PATCH" || !/\/api\/blocked-times\//.test(sent.url())) return;
    bodies.push(JSON.parse(sent.postData() ?? "{}") as Record<string, unknown>);
  });
  return bodies;
}

/** And every create body, for the half of the colour claim that is about what `POST` carries. */
function recordBlockCreates(page: Page): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  page.on("request", (sent) => {
    if (sent.method() !== "POST" || !sent.url().endsWith("/api/blocked-times")) return;
    bodies.push(JSON.parse(sent.postData() ?? "{}") as Record<string, unknown>);
  });
  return bodies;
}

/**
 * A marker that only a page load can remove.
 *
 * Every "and the calendar follows it" claim below is a claim about the CLIENT applying the server's
 * answer, and the cheapest way to fake one is a reload. Counting navigations would catch a reload
 * and also catch every same-document history call the workspace makes; a global that a reload
 * destroys catches exactly the thing being ruled out and nothing else.
 */
async function markPageLoad(page: Page): Promise<void> {
  await page.evaluate(() => { (globalThis as Record<string, unknown>).__pawshSamePage = true; });
}
async function expectSamePage(page: Page): Promise<void> {
  expect(await page.evaluate(() => (globalThis as Record<string, unknown>).__pawshSamePage),
    "the calendar had to follow the edit without the page being reloaded").toBe(true);
}

/** The create dialog's picker - the SAME component the drawer draws, scoped to the shared modal. */
function createSwatch(page: Page, name: string) {
  const picker = page.locator("#modal-fields .blocked-time-colours");
  if (name === "None") return picker.locator(".staff-swatch.is-none");
  return picker.locator(".staff-swatch:not(.is-none)").filter({ hasText: new RegExp(`^${name}$`) });
}

/** The Block choice on an empty slot, which is how an operator reaches the create dialog. */
async function openBlockCreate(page: Page, slot: string, groomerId: string): Promise<void> {
  const cell = page.locator(`[data-slot="${slot}"][data-slot-groomer="${groomerId}"]`).first();
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
  await page.getByTestId("slot-menu-block").click();
  await expect(page.getByTestId("modal")).toBeVisible();
}

/** The band's own grid column, and a slot's, so "it moved to that groomer" becomes a comparison. */
function gridColumn(locator: Locator): Promise<string> {
  return locator.evaluate((element) => (element as HTMLElement).style.gridColumn);
}

/** The day after a `YYYY-MM-DD`, sliced rather than parsed in some other zone. */
function nextDay(localDate: string): string {
  const date = new Date(`${localDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** A second groomer, so the calendar has a second column for a block to be moved into. */
async function createGroomer(
  request: APIRequestContext, tenant: TenantFixture, displayName: string
): Promise<{ id: string }> {
  const created = await request.post("/api/employees", {
    data: { displayName, serviceIds: [tenant.serviceId] }
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = await created.json() as { id: string };
  await request.put(`/api/employees/${id}/working-hours`, {
    data: { hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "08:00", endTime: "18:00" })) }
  });
  return { id };
}

/**
 * CLEARING A NOTE, AND THE FOUR PLACES THAT HAVE TO STOP SAYING IT.
 *
 * The field carried `required` for as long as the schema had no way to express "remove this": an
 * operator who emptied the box got a form that would not submit. `reason` is `.nullish()` now, so
 * the box is optional - and the whole risk moves onto the wire, because there are three ways to get
 * this wrong that look identical on screen. `""` is a 400. An absent key leaves the note in place.
 * Only `null` clears, and only the body says which one happened.
 */
test("clears a note, sending null rather than an empty string, and stops saying it everywhere",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    const patches = recordBlockPatches(page);
    await openCalendar(page);
    await markPageLoad(page);

    const band = page.getByTestId("calendar-block");
    const opener = page.locator("[data-blocked-time-open]");
    await expect(band).toHaveText("12:00 PM–12:30 PM · Lunch");

    await openBlock(page);
    const note = page.getByTestId("blocked-time-note");
    // NOT required, and the hint says what emptying it does rather than leaving it to be discovered.
    expect(await note.getAttribute("required"), "an emptiable field must not be required").toBeNull();
    await expect(page.getByTestId("blocked-time-note-hint")).toContainText("Empty the box");
    await note.fill("");
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();

    // THE WIRE. `null`, alone beside the version - not `""`, which the schema refuses, and not an
    // absent key, which would have left "Lunch" exactly where it was.
    expect(patches).toEqual([{ version: 1, reason: null }]);

    // 1. The band's label: the range alone, with no separator dangling after it.
    await expect(band).toHaveText("12:00 PM–12:30 PM");
    await expect(band).not.toContainText("·");
    // 2. The band's accessible name, which is the only channel a screen reader has here.
    await expect(opener).toHaveAttribute("aria-label", "Blocked time, 12:00 PM–12:30 PM, Grace Groomer");
    // 3. The hover, which is where a thirty-minute strip is actually read. A Reason row with
    //    nothing in it would be worse than no row at all.
    await band.hover();
    const preview = page.locator("#calendar-hover-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Block time");
    await expect(preview).not.toContainText("Reason");
    await expect(preview).not.toContainText("Lunch");
    await page.mouse.move(4, 4);
    // 4. The dialog itself, reopened.
    await openBlock(page);
    await expect(page.getByTestId("blocked-time-note")).toHaveValue("");
    await page.getByTestId("blocked-time-cancel").click();

    await expectSamePage(page);
    const [stored] = await readBlocks(request, tenant);
    expect(stored!.reason).toBeNull();
    expect(stored!.version).toBe(2);
  });

/**
 * AN UNTOUCHED DIALOG MUST NOT MOVE THE VERSION.
 *
 * Sending `reason: null` on every save would be simpler and would even work, since clearing an
 * already-null note is a server-side no-op. It would also make every Update on a block without a
 * note a write, and the version is what every other tab's optimistic concurrency rests on. So the
 * key is sent only when the note actually CHANGED, which is what this reads off the wire.
 */
test("sends its version and nothing else when nothing in the dialog was touched",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    const patches = recordBlockPatches(page);
    await openCalendar(page);
    await openBlock(page);
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();

    expect(patches).toEqual([{ version: 1 }]);
    const [stored] = await readBlocks(request, tenant);
    expect(stored!.reason).toBe("Lunch");
    expect(stored!.version, "a no-op Update must not bump the version").toBe(1);

    // Whitespace is trimmed to the stored note here as well as on the server, so padding the box
    // with spaces is still "unchanged" rather than the 400 that `"   "` would be.
    await openBlock(page);
    await page.getByTestId("blocked-time-note").fill("  Lunch  ");
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    expect(patches[1]).toEqual({ version: 1 });
    expect((await readBlocks(request, tenant))[0]!.version).toBe(1);
  });

/**
 * COLOUR AT CREATE TIME, AND IT IS THE SAME PICKER.
 *
 * `blockedTimeSchema` has accepted `colorSlot` all along; the create dialog simply had no picker, so
 * every coloured block was a create followed by an edit of the thing just created. Two things are
 * worth holding down beyond "it saves": that the palette is not forked, and that what travels is
 * the SLOT.
 */
test("chooses the block's colour in the create dialog, and persists a slot rather than a colour",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    const creates = recordBlockCreates(page);
    await openCalendar(page);
    await markPageLoad(page);

    await openBlockCreate(page, `${tenant.anchor}T14:00`, tenant.employeeId);
    // The same component: ten named colours plus the unset one, unset pre-checked, and the same
    // spoken line. Not one hex anywhere in it.
    await expect(page.locator("#modal-fields .staff-swatch")).toHaveCount(11);
    await expect(createSwatch(page, "None").locator("input")).toBeChecked();
    await expect(page.getByTestId("blocked-time-create-colour-current")).toHaveText("Selected: No colour");
    await page.getByTestId("field-endAt").fill(`${tenant.anchor}T15:00`);
    await page.getByTestId("field-reason").fill("Amber block");
    await createSwatch(page, "Amber").click();
    await expect(page.getByTestId("blocked-time-create-colour-current")).toHaveText("Selected: Amber");
    // THE SHARED RULE, ON THE SLOT THAT USED TO FAIL. Amber's tick was drawn in --g (#a96e4c) on
    // Amber's own tint (#f8f1ec): 3.74:1, a pale mark on a pale fill, which is what "the checkmark
    // for colour is inverted" describes. `staff.spec.ts` walks all ten; this measures the one that
    // was worst on the surface the defect was actually reported on, because a rule shared by two
    // screens is only shared for as long as both of them are checked.
    const chosen = await swatchMark(createSwatch(page, "Amber").locator(".staff-swatch-dot"));
    expect(chosen.drawn, "Amber draws a tick once it is the selection").toBe(true);
    expect(contrastRatio(chosen.mark, chosen.fill),
      `Amber: tick ${chosen.mark} on fill ${chosen.fill}`).toBeGreaterThanOrEqual(4.5);
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();

    // Amber is slot 3 in the one palette `Settings -> Staff` already names, and 3 is what travels.
    expect(creates).toHaveLength(1);
    expect(creates[0]!.colorSlot).toBe(3);

    const amber = page.getByTestId("calendar-block").filter({ hasText: "Amber block" });
    await expect(amber).toHaveAttribute("data-block-slot", "3");

    // NO COLOUR IS STILL THE DEFAULT, AND ROUND-TRIPS. Touching nothing in the picker sends no
    // `colorSlot` key at all, which is a null in the row and the plain hatched band on the grid.
    await openBlockCreate(page, `${tenant.anchor}T16:00`, tenant.employeeId);
    await page.getByTestId("field-endAt").fill(`${tenant.anchor}T16:30`);
    await page.getByTestId("field-reason").fill("Plain block");
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();
    expect(creates).toHaveLength(2);
    expect(creates[1]).not.toHaveProperty("colorSlot");

    const plain = page.getByTestId("calendar-block").filter({ hasText: "Plain block" });
    await expect(plain).toBeVisible();
    expect(await plain.getAttribute("data-block-slot")).toBeNull();

    await expectSamePage(page);
    const stored = await readBlocks(request, tenant);
    expect(stored.find((block) => block.reason === "Amber block")!.colorSlot).toBe(3);
    expect(stored.find((block) => block.reason === "Plain block")!.colorSlot).toBeNull();

    // And the drawer reads the created colour back, which closes the round trip.
    await amber.click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
    await expect(page.getByTestId("blocked-time-colour-current")).toHaveText("Selected: Amber");
    // ...and the drawer draws the same legible tick the create dialog did.
    const reread = await swatchMark(swatch(page, "Amber").locator(".staff-swatch-dot"));
    expect(reread.drawn, "the reopened drawer ticks the stored colour").toBe(true);
    expect(contrastRatio(reread.mark, reread.fill),
      `Amber in the drawer: tick ${reread.mark} on fill ${reread.fill}`).toBeGreaterThanOrEqual(4.5);
  });

/**
 * THE CONFIRMATION'S EXITS, COUNTED RATHER THAN LOOKED AT.
 *
 * A block still on the calendar afterwards proves that no delete SUCCEEDED, which is not the claim.
 * The claim is that none was ATTEMPTED, so the DELETE count is what is read.
 *
 * `#stacked-dialog` - the shared confirmation the drag-move already uses - offers Cancel and Escape
 * and deliberately carries no × of its own. Adding one for this dialog would fork a component with
 * thirty call sites, so the third exit exercised is the one that exists: the Block Time drawer's
 * own ×, taken with the confirmation dismissed, which abandons the whole flow.
 */
test("leaves the delete confirmation by every exit it has without issuing a DELETE",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    const mutations = countBlockMutations(page);
    await openCalendar(page);

    // The question has to identify the block well enough that the wrong one is recognisable BEFORE
    // the row is gone: which day, which clock range, whose column, and what it says - each through
    // the preference layer, so it reads the way the band above it reads rather than the way the
    // browser's own locale would lay it out.
    await openBlock(page);
    await page.getByTestId("blocked-time-delete").click();
    const question = page.getByTestId("blocked-time-delete-question");
    await expect(question).toContainText(`Monday, ${prefLocalDate(tenant.anchor)}`);
    await expect(question).toContainText("12:00 PM–12:30 PM");
    await expect(question).toContainText("Grace Groomer");
    await expect(question).toContainText("Lunch");

    // 1. Cancel.
    await page.getByTestId("stacked-dialog-dismiss").click();
    await expect(page.getByTestId("stacked-dialog")).toBeHidden();
    // The Block Time dialog is still open behind it: dismissing the confirmation cancels the
    // delete, not the editing session.
    await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();

    // 2. Escape.
    await page.getByTestId("blocked-time-delete").click();
    await expect(page.getByTestId("stacked-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("stacked-dialog")).toBeHidden();
    await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();

    // 3. The dialog's own ×, with the confirmation already dismissed: the whole flow abandoned.
    await page.getByTestId("blocked-time-delete").click();
    await expect(page.getByTestId("stacked-dialog")).toBeVisible();
    await page.getByTestId("stacked-dialog-dismiss").click();
    await expect(page.getByTestId("stacked-dialog")).toBeHidden();
    await page.getByTestId("blocked-time-close").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();

    expect(mutations, "no exit from the confirmation may mutate").toEqual({ patch: 0, delete: 0 });
    await expect(page.getByTestId("calendar-block")).toHaveCount(1);
    const [stored] = await readBlocks(request, tenant);
    expect(stored!.version).toBe(1);
  });

/**
 * WHERE FOCUS GOES WHEN THE BAND IT CAME FROM NO LONGER EXISTS.
 *
 * Every other exit hands focus back to the band's opener. A delete is the one exit where the redraw
 * has already removed that element, and `focus()` on a detached node fails silently onto `<body>` -
 * which on a horizontally scrolled week grid loses a keyboard operator's place completely. The
 * destination chosen is the SLOT the block was sitting on, in the same groomer's column: the cell
 * the band physically occupied, and the control that now offers what the delete just made possible.
 */
test("hands focus to the slot the deleted block was sitting on rather than to the document",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);

    // Reached by keyboard, because the destination only matters to somebody using one.
    const opener = page.locator("[data-blocked-time-open]");
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
    await page.getByTestId("blocked-time-delete").click();
    await page.getByTestId("stacked-dialog-confirm").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    await expect(page.getByTestId("calendar-block")).toHaveCount(0);

    await expect.poll(() => page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      return {
        tag: element?.tagName ?? null,
        slot: element?.getAttribute("data-slot") ?? null,
        groomer: element?.getAttribute("data-slot-groomer") ?? null
      };
    }), "focus must land on the slot the block was holding, not on <body>")
      .toEqual({ tag: "BUTTON", slot: `${tenant.anchor}T12:00`, groomer: tenant.employeeId });
  });

/**
 * ENTER AND SPACE, AND WHY THERE IS NO KEY HANDLER ANYWHERE NEAR THEM.
 *
 * The band's opener is a real `<button type="button">` nested inside the `.calendar-block` div, so
 * both keys already produce a `click` and the one listener the file binds is all there is. This
 * asserts the platform's behaviour rather than adding to it: the failure being guarded against is
 * somebody "improving" the band into a `<div role="button">` and reintroducing the two handlers -
 * and the missing one - by hand.
 */
test("opens the block with Enter and with Space, from the band's own tab stop",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);

    const opener = page.locator("[data-blocked-time-open]");
    expect(await opener.evaluate((element) => element.tagName),
      "a native button gets Enter and Space for free").toBe("BUTTON");

    for (const key of ["Enter", " "]) {
      await opener.focus();
      await page.keyboard.press(key);
      await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
      await expect(page.getByTestId("blocked-time-note")).toHaveValue("Lunch");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
      // Closing returns focus to the band that opened it, which is what makes the loop repeatable
      // by keyboard alone - and is the half a mouse-driven test would never notice breaking.
      await expect(opener).toBeFocused();
    }
  });

/**
 * ALL SIX REFRESHES, IN ONE PAGE THAT IS NEVER RELOADED.
 *
 * Each is a different path through the client: a create applies the POST's projection, four edits
 * apply the PATCH's, and the delete removes the row and redraws. They run in one session on purpose
 * - a reload between them would hide exactly the failure this exists for, which is a client that
 * only looks correct because something else fetched the world again.
 *
 * The staff edit is the one that needs a second groomer. Moving a block between employees moves it
 * between COLUMNS, which is a different piece of the paint from moving it between rows, and a band
 * that kept its column while its label changed would satisfy every other assertion here.
 */
test("follows a create, four edits and a delete on the calendar without reloading the page",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const wanda = await createGroomer(request, tenant, "Wanda Washer");
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await markPageLoad(page);

    // 1. CREATE -> the band appears.
    await openBlockCreate(page, `${tenant.anchor}T12:00`, tenant.employeeId);
    await page.getByTestId("field-endAt").fill(`${tenant.anchor}T12:30`);
    await page.getByTestId("field-reason").fill("Lunch");
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();
    const band = page.getByTestId("calendar-block");
    await expect(band).toHaveCount(1);
    await expect(band).toHaveText("12:00 PM–12:30 PM · Lunch");
    expect(await band.getAttribute("data-block-slot")).toBeNull();
    const graceColumn = await gridColumn(band);

    // 2. SCHEDULE EDIT -> the band moves, down its own column.
    await openBlock(page);
    await page.getByTestId("blocked-time-start").fill("13:00");
    await page.getByTestId("blocked-time-end").fill("14:00");
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    await expect(band).toHaveText("1:00 PM–2:00 PM · Lunch");
    // Row 3 is the first drawn half hour and the salon opens at 08:00, so 13:00 is ten of them
    // later and an hour is two of them.
    expect(await band.evaluate((element) => (element as HTMLElement).style.gridRow))
      .toMatch(/^13\s*\/\s*span 2$/);
    expect(await gridColumn(band)).toBe(graceColumn);

    // 3. STAFF EDIT -> the band changes COLUMNS, into the other groomer's.
    await openBlock(page);
    await page.getByTestId("blocked-time-staff").selectOption(wanda.id);
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    const wandaColumn = await gridColumn(
      page.locator(`[data-slot="${tenant.anchor}T13:00"][data-slot-groomer="${wanda.id}"]`).first());
    expect(wandaColumn).not.toBe(graceColumn);
    expect(await gridColumn(band), "a block belongs to whoever owns it").toBe(wandaColumn);
    await expect(page.locator("[data-blocked-time-open]"))
      .toHaveAttribute("aria-label", "Blocked time, 1:00 PM–2:00 PM, Wanda Washer, Lunch");

    // 4. COLOUR EDIT -> the tint updates.
    await openBlock(page);
    await swatch(page, "Teal").click();
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    await expect(band).toHaveAttribute("data-block-slot", "2");

    // 5a. NOTE EDIT -> the label and the tooltip both follow.
    const preview = page.locator("#calendar-hover-preview");
    await openBlock(page);
    await page.getByTestId("blocked-time-note").fill("Team meeting");
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    await expect(band).toHaveText("1:00 PM–2:00 PM · Team meeting");
    await band.hover();
    await expect(preview).toContainText("Team meeting");
    await page.mouse.move(4, 4);

    // 5b. NOTE CLEAR -> and they both stop saying it.
    await openBlock(page);
    await page.getByTestId("blocked-time-note").fill("");
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    await expect(band).toHaveText("1:00 PM–2:00 PM");
    await band.hover();
    await expect(preview).toBeVisible();
    await expect(preview).not.toContainText("Team meeting");
    await expect(preview).not.toContainText("Reason");
    await page.mouse.move(4, 4);

    // 6. DELETE -> the band disappears.
    await openBlock(page);
    await page.getByTestId("blocked-time-delete").click();
    await page.getByTestId("stacked-dialog-confirm").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    await expect(band).toHaveCount(0);

    // Six paints, one page load, and the row agrees with the last of them.
    await expectSamePage(page);
    expect(await readBlocks(request, tenant)).toEqual([]);
  });

/**
 * A MULTI-DAY BLOCK MUST SURVIVE A NOTE-ONLY EDIT UNCHANGED.
 *
 * The dialog offers ONE date, so a block running longer than the next morning cannot be expressed by
 * it - the schedule is disabled with the reason on it rather than silently truncated to the first
 * day. What that leaves is a client that must not send a schedule group it did not mean to:
 * `blockedTimeUpdatePayload` gates the whole group on the span being editable, so a note-and-colour
 * save carries `version`, `reason` and `colorSlot` and says nothing whatever about when the block
 * is. The wire is read here for the same reason it is read above - the stored instants agreeing
 * afterwards would also be true of a client that sent them back correctly by luck.
 */
test("edits a multi-day block's note and colour without sending, or moving, its schedule",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${nextDay(tenant.anchor)}T16:00`,
      reason: "Conference"
    });
    await login(page, tenant.ownerEmail);
    const patches = recordBlockPatches(page);
    await openCalendar(page);

    await openBlock(page);
    // The schedule is disabled here, so opening skips past it to the first field that is not -
    // the note - rather than aiming at a disabled Date and landing nowhere.
    await expect(page.getByTestId("blocked-time-note")).toBeFocused();
    await expect(page.getByTestId("blocked-time-locked")).toContainText("more than one day");
    await expect(page.getByTestId("blocked-time-date")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-start")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-end")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-staff")).toBeDisabled();
    // Colour and note stay editable, which is the whole point of disabling rather than refusing.
    await expect(page.getByTestId("blocked-time-note")).toBeEnabled();
    await expect(swatch(page, "Olive").locator("input")).toBeEnabled();

    await page.getByTestId("blocked-time-note").fill("Conference, day two");
    await swatch(page, "Olive").click();
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();

    // No `localStart`, no `localEnd`, no `employeeId`, no `expectedLocationVersion`.
    expect(patches).toEqual([{ version: 1, reason: "Conference, day two", colorSlot: 4 }]);
    const [stored] = await readBlocks(request, tenant);
    expect(stored!.scheduledLocalStart).toBe(`${tenant.anchor}T12:00`);
    expect(stored!.scheduledLocalEnd).toBe(`${nextDay(tenant.anchor)}T16:00`);
    expect(stored!.reason).toBe("Conference, day two");
    expect(stored!.colorSlot).toBe(4);
  });

/**
 * A BLOCK CREATED WITH NO NOTE AT ALL.
 *
 * `blocked_times.reason` has been nullable since 0001 and the calendar has drawn the null case
 * correctly since seam 1 - but until the create route's note became optional, that path was
 * reachable ONLY by a legacy row or a hand-written UPDATE, which is why the existing coverage for
 * it needs a database of its own to set up. It is reachable through the front door now, so it is
 * exercised through the front door: the same create dialog an operator uses, with the note left
 * alone.
 *
 * WHAT IS BEING WATCHED IS THE ABSENCE OF DEBRIS. A label built by joining a range and a note with
 * a separator has an obvious failure - the separator survives the missing half - and it has three
 * quieter ones behind it: an accessible name with a trailing comma, a hover tooltip carrying a
 * Reason row with nothing in it, and an empty element that a screen reader still announces. All
 * four are asserted, because only the first of them is visible in a screenshot.
 */
test("creates a block with no note, and the calendar says only its time",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    const creates = recordBlockCreates(page);
    await openCalendar(page);
    await markPageLoad(page);

    await openBlockCreate(page, `${tenant.anchor}T14:00`, tenant.employeeId);
    // Optional, and saying so where the box is rather than leaving it to be tried.
    const note = page.getByTestId("field-reason");
    expect(await note.getAttribute("required"), "an optional note must not be required").toBeNull();
    await page.getByTestId("field-endAt").fill(`${tenant.anchor}T15:00`);
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();

    // NO `reason` KEY AT ALL, and in particular not `""` - which the create schema refuses for the
    // same reason its edit twin does.
    expect(creates).toHaveLength(1);
    expect(creates[0]).not.toHaveProperty("reason");

    const band = page.getByTestId("calendar-block");
    const opener = page.locator("[data-blocked-time-open]");
    // 1. The label is the range and nothing else: no separator with nothing after it, and no
    //    invented word standing in for a reason the salon never gave.
    await expect(band).toHaveText("2:00 PM–3:00 PM");
    await expect(band).not.toContainText("·");
    // 2. The accessible name ends at the groomer, with no trailing comma waiting for a note.
    await expect(opener).toHaveAttribute("aria-label", "Blocked time, 2:00 PM–3:00 PM, Grace Groomer");
    // 3. No empty element left behind for a screen reader to announce as a blank.
    expect(await band.evaluate((element) =>
      [...element.querySelectorAll("*")].some((child) => child.textContent?.trim() === "")),
      "an empty label element is still an element").toBe(false);
    // 4. The hover, where a thirty-minute strip is actually read.
    await band.hover();
    const preview = page.locator("#calendar-hover-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Block time");
    await expect(preview).toContainText("2:00 PM–3:00 PM");
    await expect(preview).not.toContainText("Reason");
    await page.mouse.move(4, 4);

    await expectSamePage(page);
    const [stored] = await readBlocks(request, tenant);
    expect(stored!.reason).toBeNull();

    // And the drawer opens on it with an empty, editable note rather than refusing to submit.
    await openBlock(page);
    await expect(page.getByTestId("blocked-time-note")).toHaveValue("");
    await expect(page.getByTestId("blocked-time-note")).toBeEnabled();
    await expect(page.getByTestId("blocked-time-note-hint")).toContainText("Empty the box");
    // A note added to a block that had none is the other half of the same contract.
    await page.getByTestId("blocked-time-note").fill("Dentist");
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    await expect(band).toHaveText("2:00 PM–3:00 PM · Dentist");
    expect((await readBlocks(request, tenant))[0]!.reason).toBe("Dentist");
  });

/**
 * DISMISSING AND REOPENING IN THE SAME TURN MUST NOT LEAVE A BLANK MODAL.
 *
 * `<dialog>` dispatches `close` in a QUEUED TASK, not synchronously with the dismissal. The
 * teardown hangs off that event - it nulls the editor and empties the element, both of which are
 * right for the session being closed - so a reopen that lands between the dismissal and the queued
 * task gets built and then wiped by a handler belonging to the dialog before it. What was left was
 * an OPEN, EMPTY modal: no fields, no ×, no editor behind it, and a backdrop over the calendar.
 *
 * It is a race, so it is exercised the way a race has to be - repeatedly, and by keyboard, which is
 * where the two events land closest together. Six rounds is enough that the ordering the bug needs
 * occurs; one round passed for weeks while the defect was there.
 */
test("survives dismissing and reopening in the same turn, without blanking the dialog",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    const mutations = countBlockMutations(page);
    await openCalendar(page);

    const opener = page.locator("[data-blocked-time-open]");
    for (let round = 0; round < 6; round += 1) {
      for (const key of ["Enter", " "]) {
        await opener.focus();
        await page.keyboard.press(key);
        // Open AND furnished. `toBeVisible` alone was what let the defect through: the wiped dialog
        // was still open, so it was still visible, and still had nothing in it.
        await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
        await expect(page.getByTestId("blocked-time-note"),
          `round ${round} via ${JSON.stringify(key)} must reopen a furnished dialog`)
          .toHaveValue("Lunch");
        await expect(page.getByTestId("blocked-time-date")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
        // Focus is back on the band, which is what makes the next round reachable by keyboard.
        await expect(opener).toBeFocused();
      }
    }
    // Twelve opens and twelve dismissals, and not one of them wrote anything.
    expect(mutations).toEqual({ patch: 0, delete: 0 });
  });

/**
 * A NEW BLOCK IS AN HOUR, AND THE HOUR FOLLOWS THE START UNTIL SOMEBODY OVERRULES IT.
 *
 * The dialog used to take its Start from the clicked slot and leave the End blank, so the commonest
 * block anybody makes - the next hour - was a full datetime typed out from scratch every time. The
 * rule these tests hold is deliberately narrow, because a suggestion that keeps overwriting an
 * answer is worse than no suggestion: the End follows Start + 1h until the OPERATOR edits the End,
 * and from that moment the End is theirs for the rest of the opening.
 */
test("opens a new block an hour long, from the slot and from the New menu",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);

    // From a clicked slot: the Start is the slot, and the End is an hour past it.
    await openBlockCreate(page, `${tenant.anchor}T14:00`, tenant.employeeId);
    await expect(page.getByTestId("field-startAt")).toHaveValue(`${tenant.anchor}T14:00`);
    await expect(page.getByTestId("field-endAt")).toHaveValue(`${tenant.anchor}T15:00`);
    await page.getByTestId("modal").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByTestId("modal")).toBeHidden();

    // From the New menu, where there is no preset at all: both boxes open empty, because an End
    // suggested against nothing would be a time nobody chose hanging in a required field.
    await page.getByTestId("new-action-trigger").click();
    await page.getByTestId("new-action-menu").getByRole("menuitem", { name: "New Block Time" }).click();
    await expect(page.getByTestId("modal")).toBeVisible();
    await expect(page.getByTestId("field-startAt")).toHaveValue("");
    await expect(page.getByTestId("field-endAt")).toHaveValue("");

    // The moment a Start is chosen, the End is an hour after it.
    await page.getByTestId("field-startAt").fill(`${tenant.anchor}T11:00`);
    await expect(page.getByTestId("field-endAt")).toHaveValue(`${tenant.anchor}T12:00`);
    // And it keeps following while it is still the dialog's suggestion rather than the operator's.
    await page.getByTestId("field-startAt").fill(`${tenant.anchor}T16:15`);
    await expect(page.getByTestId("field-endAt")).toHaveValue(`${tenant.anchor}T17:15`);
  });

test("stops moving the End the moment the operator sets one, and offers the hour again next time",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    const creates = recordBlockCreates(page);
    await openCalendar(page);

    await openBlockCreate(page, `${tenant.anchor}T14:00`, tenant.employeeId);
    await expect(page.getByTestId("field-endAt")).toHaveValue(`${tenant.anchor}T15:00`);

    // The operator answers the End themselves. It is theirs from here.
    await page.getByTestId("field-endAt").fill(`${tenant.anchor}T14:20`);
    await page.getByTestId("field-startAt").fill(`${tenant.anchor}T13:00`);
    await expect(page.getByTestId("field-endAt")).toHaveValue(`${tenant.anchor}T14:20`);

    await page.getByTestId("field-reason").fill("Twenty minutes");
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();
    expect(creates).toHaveLength(1);
    // What was in the fields is what travelled: the suggestion never rewrote the answer on submit.
    expect(creates[0]!.localStart).toBe(`${tenant.anchor}T13:00`);
    expect(creates[0]!.localEnd).toBe(`${tenant.anchor}T14:20`);

    // A new opening is a new suggestion. The latch belongs to one dialog, not to the session.
    await openBlockCreate(page, `${tenant.anchor}T16:00`, tenant.employeeId);
    await expect(page.getByTestId("field-endAt")).toHaveValue(`${tenant.anchor}T17:00`);
  });

/**
 * THE HOUR / MINUTE / AM-PM SCROLL PICKER, WHICH IS BLOCK TIME'S ALONE.
 *
 * The native time input is the one part of these two dialogs the product cannot style, cannot lay
 * out in the workspace's own hour format, and cannot make comfortable to hit. The picker is an
 * ADDITIONAL way to fill the same field - the `<input>` keeps its name, its type and its value, and
 * the submit path reads exactly what it always read - so every test below asserts the field, not
 * some parallel state.
 *
 * The two that matter most are the dismissals. OK commits and NOTHING ELSE DOES: an Escape that
 * quietly wrote would move a block by being looked at, and an Escape that closed the DIALOG behind
 * the popover would throw away an edit in progress. Both are asserted rather than assumed.
 */
test("fills the Start from three scrolling columns, and commits only on OK",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await openBlock(page);

    const start = page.getByTestId("blocked-time-start");
    await expect(start).toHaveValue("12:00");
    await page.getByTestId("blocked-time-start-picker").click();

    const popover = page.locator("#time-picker-localStartTime");
    await expect(popover).toBeVisible();
    await expect(page.getByTestId("blocked-time-start-picker")).toHaveAttribute("aria-expanded", "true");
    // The reference's three columns, each one named so a reader arriving on a column of numbers is
    // told which numbers they are.
    await expect(popover.getByRole("listbox")).toHaveCount(3);
    for (const name of ["Hour", "Minute", "AM or PM"])
      await expect(popover.getByRole("listbox", { name })).toBeVisible();
    // Hours 01-12, minutes on the five-minute ladder, and the block's own time already chosen.
    await expect(popover.getByRole("listbox", { name: "Hour" }).getByRole("option")).toHaveCount(12);
    await expect(popover.getByRole("listbox", { name: "Minute" }).getByRole("option")).toHaveCount(12);
    await expect(popover.getByRole("option", { name: "12", selected: true }).first()).toBeVisible();
    await expect(popover.getByRole("option", { name: "PM", selected: true })).toBeVisible();
    // The option rows are the tested target size, because they are what a thumb aims at.
    await expectCriticalTarget(popover.getByRole("option", { name: "03" }));
    await expectCriticalTarget(page.getByTestId("blocked-time-start-picker-ok"));

    // DISMISSING COMMITS NOTHING, and leaves the dialog behind it open.
    await popover.getByRole("option", { name: "09" }).click();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
    await expect(start).toHaveValue("12:00");
    await expect(page.getByTestId("blocked-time-start-picker")).toHaveAttribute("aria-expanded", "false");
    // And the focus is back where the operator left it, rather than lost to the document.
    await expect(page.getByTestId("blocked-time-start-picker")).toBeFocused();

    // OK COMMITS. Nine, thirty-five, AM.
    await page.getByTestId("blocked-time-start-picker").click();
    await popover.getByRole("option", { name: "09" }).click();
    await popover.getByRole("listbox", { name: "Minute" }).getByRole("option", { name: "35" }).click();
    await popover.getByRole("option", { name: "AM" }).click();
    await page.getByTestId("blocked-time-start-picker-ok").click();
    await expect(popover).toBeHidden();
    await expect(start).toHaveValue("09:35");
    // The field is not the only thing that changed: the dialog's own reading of it follows, which
    // is the line an operator on a 24-hour workspace actually reads.
    await expect(page.getByTestId("blocked-time-when")).toContainText("9:35 AM–12:30 PM");
  });

test("drives the picker from the keyboard alone, and saves what it committed",
  async ({ page, request, tenant }) => {
    // AT 15:00, where the rest of this file books 09:00. The commit below moves the block's Start
    // back to 2:50 AM, which stretches it to 02:50-12:30, and blocked time may not cover a booked
    // appointment: a 09:00 Full Groom runs to 10:30, so Update would come back 409
    // BLOCK_TIME_APPOINTMENT_CONFLICT and the save this test exists to prove would never happen.
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T15:00` });
    const block = await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await openBlock(page);

    // Reached by keyboard: the clock is a real button in the form's own tab order, and it is the
    // NEXT stop after the Start field with nothing interposed.
    //
    // Tabbed to in a loop rather than once, because a native `<input type="time">` is SEVERAL tab
    // stops inside a single element - hour, minute, and on a 12-hour workspace AM/PM - and
    // `document.activeElement` stays the input for every one of them. Pressing Tab once therefore
    // moves within the field and proves nothing; the claim worth holding is where focus lands when
    // it finally leaves, and the loop still fails if anything is interposed before the clock.
    const startField = page.getByTestId("blocked-time-start");
    await startField.focus();
    for (let guard = 0; guard < 6 && await startField.evaluate((node) => node === document.activeElement); guard += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(page.getByTestId("blocked-time-start-picker")).toBeFocused();
    await page.keyboard.press("Enter");

    const popover = page.locator("#time-picker-localStartTime");
    await expect(popover).toBeVisible();
    // Each column is ONE tab stop with `aria-activedescendant`, not twelve - so the arrows move
    // within a column and Tab moves between them.
    const hours = popover.getByRole("listbox", { name: "Hour" });
    await expect(hours).toBeFocused();
    await expect(hours).toHaveAttribute("aria-activedescendant", "time-picker-localStartTime-hour-12");
    await page.keyboard.press("Home");
    await expect(hours).toHaveAttribute("aria-activedescendant", "time-picker-localStartTime-hour-1");
    await page.keyboard.press("ArrowDown");
    await expect(hours).toHaveAttribute("aria-activedescendant", "time-picker-localStartTime-hour-2");

    await page.keyboard.press("Tab");
    const minutes = popover.getByRole("listbox", { name: "Minute" });
    await expect(minutes).toBeFocused();
    await page.keyboard.press("End");
    await expect(minutes).toHaveAttribute("aria-activedescendant", "time-picker-localStartTime-minute-55");
    await page.keyboard.press("ArrowUp");
    await expect(minutes).toHaveAttribute("aria-activedescendant", "time-picker-localStartTime-minute-50");

    await page.keyboard.press("Tab");
    const meridiem = popover.getByRole("listbox", { name: "AM or PM" });
    await expect(meridiem).toBeFocused();
    // Up from PM is AM, which keeps the new Start in front of the block's 12:30 End rather than
    // turning this edit into an overnight one and testing two things at once.
    await page.keyboard.press("ArrowUp");
    await expect(meridiem).toHaveAttribute("aria-activedescendant", "time-picker-localStartTime-meridiem-am");
    await page.keyboard.press("Enter");

    await expect(popover).toBeHidden();
    await expect(page.getByTestId("blocked-time-start")).toHaveValue("02:50");
    // The commit is spoken, because a reader whose focus has just been handed back to the clock
    // button would otherwise be told nothing at all about what they had just chosen.
    await expect(page.locator('[data-time-picker-field="localStartTime"] [data-time-picker-live]'))
      .toHaveText("Start set to 2:50 AM");
    await expect(page.getByTestId("blocked-time-when")).toContainText("2:50 AM–12:30 PM");

    // And what the picker put in the field is what Update sends.
    await page.getByTestId("blocked-time-update").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    const stored = await readBlocks(request, tenant);
    expect(stored.find((item) => item.id === block.id)!.scheduledLocalStart)
      .toBe(`${tenant.anchor}T02:50`);
  });

test("drops the AM/PM column and runs 00-23 on a twenty-four-hour workspace",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T14:00`, localEnd: `${tenant.anchor}T14:30`, reason: "Staff meeting"
    });
    await login(page, tenant.ownerEmail);

    await page.getByTestId("nav-settings").click();
    await expect(page.getByTestId("admin-settings-view")).toBeVisible();
    await page.locator("#settings-navigation").getByRole("button", { name: "Business", exact: true }).click();
    await page.getByTestId("business-hour-format").selectOption("24");
    await page.getByTestId("business-save").click();
    await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");
    await page.reload();
    await openCalendar(page);
    await openBlock(page);

    await page.getByTestId("blocked-time-start-picker").click();
    const popover = page.locator("#time-picker-localStartTime");
    await expect(popover).toBeVisible();
    // Two columns, not three. There is no meridiem to choose, so offering one would be a control
    // that cannot be wrong and cannot be useful.
    await expect(popover.getByRole("listbox")).toHaveCount(2);
    await expect(popover.getByRole("listbox", { name: "AM or PM" })).toHaveCount(0);
    await expect(popover.getByRole("listbox", { name: "Hour" }).getByRole("option")).toHaveCount(24);
    await expect(popover.getByRole("option", { name: "00" }).first()).toBeVisible();
    await expect(popover.getByRole("option", { name: "23" })).toBeVisible();
    // 14:00 is already chosen, in the hours the workspace asked to read.
    await expect(popover.getByRole("option", { name: "14", selected: true })).toBeVisible();

    await popover.getByRole("listbox", { name: "Hour" }).getByRole("option", { name: "19" }).click();
    await page.getByTestId("blocked-time-start-picker-ok").click();
    await expect(page.getByTestId("blocked-time-start")).toHaveValue("19:00");
    await expect(page.getByTestId("blocked-time-when")).toContainText("19:00–14:30");
    await expect(page.getByTestId("blocked-time-when")).not.toContainText(/[AP]M/);
  });

test("puts the same picker on both ends of the create dialog, and on nothing else",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    const creates = recordBlockCreates(page);
    await openCalendar(page);
    await openBlockCreate(page, `${tenant.anchor}T14:00`, tenant.employeeId);

    // Committing on the End counts as the operator setting it, so the one-hour link lets go.
    await page.getByTestId("field-endAt-picker").click();
    const endPopover = page.locator("#time-picker-endAt");
    await expect(endPopover).toBeVisible();
    await endPopover.getByRole("listbox", { name: "Minute" }).getByRole("option", { name: "45" }).click();
    await page.getByTestId("field-endAt-picker-ok").click();
    await expect(page.getByTestId("field-endAt")).toHaveValue(`${tenant.anchor}T15:45`);

    // Committing on the Start moves the Start and leaves the answered End alone.
    await page.getByTestId("field-startAt-picker").click();
    const startPopover = page.locator("#time-picker-startAt");
    await startPopover.getByRole("listbox", { name: "Hour" }).getByRole("option", { name: "01" }).click();
    await startPopover.getByRole("option", { name: "PM" }).click();
    await page.getByTestId("field-startAt-picker-ok").click();
    // The date the field already carried is untouched: only the clock was replaced.
    await expect(page.getByTestId("field-startAt")).toHaveValue(`${tenant.anchor}T13:00`);
    await expect(page.getByTestId("field-endAt")).toHaveValue(`${tenant.anchor}T15:45`);

    await page.getByTestId("field-reason").fill("Picked with the clock");
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();
    expect(creates).toHaveLength(1);
    expect(creates[0]!.localStart).toBe(`${tenant.anchor}T13:00`);
    expect(creates[0]!.localEnd).toBe(`${tenant.anchor}T15:45`);

    // AND NOWHERE ELSE. The seam is Block Time; booking still uses the browser's own control.
    await page.getByTestId("new-action-trigger").click();
    await page.getByTestId("new-action-menu").getByRole("menuitem", { name: "New Appointment" }).click();
    await expect(page.getByTestId("booking-dialog")).toBeVisible();
    await expect(page.getByTestId("booking-dialog").locator(".time-picker-trigger")).toHaveCount(0);
  });

test("disables the clock for a member who cannot change the block, rather than hiding it",
  async ({ page, request, tenant }) => {
    // Disabled, not hidden, exactly as the fields it sits beside are - and disabled for the same
    // reason: a live clock next to a dead input is an affordance that does nothing.
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    const groomer = await createMember(request, `clock+${tenant.runId}@pawsh-test.example`,
      permissionPresets.groomer!.filter((key) => key !== "calendar.blocks_edit"));

    await login(page, groomer.email);
    await openCalendar(page);
    await openBlock(page);

    await expect(page.getByTestId("blocked-time-start")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-start-picker")).toHaveCount(1);
    await expect(page.getByTestId("blocked-time-start-picker")).toBeDisabled();
    await expect(page.getByTestId("blocked-time-end-picker")).toBeDisabled();
    // A disabled trigger opens nothing, so there is no popover to leave behind either.
    await expect(page.locator("#time-picker-localStartTime")).toBeHidden();
  });
