import { test, expect, login, createAppointment, createMember, prepareReceipt, password } from "./fixtures/tenant.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { contrastRatio } from "./helpers/contrast.js";
import { expectEffectiveTarget, expectTouchTarget } from "./helpers/responsive.js";
import { revealAppointmentOnCalendar } from "./helpers/calendar.js";
import { permissionPresets } from "@pawsh/domain";

/**
 * THE SIX THINGS HUMAN QA FOUND ON THE APPOINTMENT SURFACE, held in a real browser.
 *
 * `tests/ui/appointment-dominant-slot.test.ts` holds what the footer DRAWS, deterministically,
 * against the real `derive()` and the real markup. What it cannot hold is what a person SEES and
 * what the cascade does to it, which is what every finding in that pass was about:
 *
 *   THE GROOMER'S FOOTER, as a groomer, on a visit that was checked in on the server - Ready for
 *       Pickup enabled and leading, no footer Save at all, and the service note committing from
 *       its own block.
 *   THE PENCIL'S CONTRAST, measured off the rendered page in every state it has, because a
 *       glyph's legibility is a property of the paint, not of the source.
 *   THE PET CONTEXT IN A DIALOG, where the defect was a grid stretching a pill to its neighbour's
 *       height - a layout fact only a layout engine can produce.
 *   `.compact` ACTUALLY COMPACT on both pointers, and still a 44px TARGET on a coarse one through
 *       the shared hit area - a media query only a device profile can exercise.
 *
 * The `@responsive` test at the end runs under the iPhone and Pixel projects as well as desktop
 * Chromium, which is what makes the coarse-pointer floor an assertion rather than a hope.
 */

// THE BUILT-IN GROOMER, as the domain defines it, so the footer under test is the one a real
// groomer sees and a key joining or leaving the preset is felt here rather than restated.
const GROOMER_PRESET = [...permissionPresets.groomer!];

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");

async function transition(api: APIRequestContext, id: string, status: string, version: number): Promise<number> {
  const response = await api.post(`/api/appointments/${id}/transition`, { data: { status, version } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { version: number }).version;
}

async function openNavigation(page: Page): Promise<void> {
  if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-calendar").isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
}

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await openNavigation(page);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await revealAppointmentOnCalendar(page, appointmentId);
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

/** The rendered ink and fill of one control, plus whether the focus ring rule is in force. */
async function paint(locator: Locator): Promise<{ ink: string; fill: string; focusVisible: boolean; height: number }> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      ink: style.color, fill: style.backgroundColor,
      focusVisible: element.matches(":focus-visible"),
      height: element.getBoundingClientRect().height
    };
  });
}

test("a groomer's checked-in footer leads with Ready for Pickup, and the service note commits from its block",
  async ({ page, request, tenant }) => {
    // BACKEND-DEPENDENT for the groomer half: the member is linked to the fixture employee so the
    // visit is THEIRS, which needs `employeeId` on `GET /api/me` for the scope rule to allow it.
    const appointment = await createAppointment(request, tenant);
    await transition(request, appointment.id, "checked_in", appointment.version);
    const member = await createMember(request, `groomer+${tenant.runId}@pawsh-test.example`, GROOMER_PRESET);
    const linked = await request.put(`/api/employees/${tenant.employeeId}`, { data: { membershipId: member.membershipId } });
    expect(linked.ok(), await linked.text()).toBeTruthy();
    await login(page, member.email, password);
    await openDetail(page, appointment.id);

    const ready = detail(page).getByTestId("appointment-ready");
    // THE ONE ENABLED ACTION IS THE PRIMARY. Before this, a disabled Save held the slot and the
    // footer was read as "no Ready for Pickup".
    await expect(ready).toBeEnabled();
    await expect(ready).toHaveClass(/\bprimary\b/);
    await expect(detail(page).locator("footer .primary")).toHaveCount(1);
    await expect(detail(page).getByTestId("appointment-take-payment")).toHaveCount(0);
    // THERE IS NO FOOTER SAVE. Its only job was the service note, and a commit a screen away from
    // the field it committed is what human QA typed into and lost.
    await expect(detail(page).getByTestId("appointment-save")).toHaveCount(0);

    // THE SERVICE NOTE IS AN EDITOR OF ITS OWN. Empty, so it is Add; the press opens the box with
    // the caret in it and Save beside it.
    const edit = detail(page).getByTestId("appointment-service-note-edit");
    await expect(edit).toHaveText("Add");
    await expect(edit).toHaveAttribute("aria-label", "Add service note");
    await expect(edit).toBeEnabled();
    await edit.click();
    const field = detail(page).getByTestId("appointment-service-note-input");
    await expect(field).toBeFocused();
    await field.fill("Clipped short around the paws at the owner's request.");
    await detail(page).getByTestId("appointment-service-note-save").click();

    // Saved, the heading follows what the server now holds, and the note reads as text.
    await expect(edit).toHaveText("Edit");
    await expect(edit).toHaveAttribute("aria-label", "Edit service note");
    await expect(detail(page).getByTestId("appointment-service-note"))
      .toHaveText("Clipped short around the paws at the owner's request.");
  });

test("a settled visit never leads with an Invoice the groomer cannot open", async ({ page, request, tenant }) => {
  const { appointment } = await prepareReceipt(request, tenant);
  // A member with no employee record of their own: the visit is nobody's, so the receipt route's
  // own-settled-visit allowance does not reach them and only payments.view would. The case where
  // it DOES reach the groomer - their own paid visit - is `groomer-scope.spec.ts`.
  const member = await createMember(request, `groomer-paid+${tenant.runId}@pawsh-test.example`, GROOMER_PRESET);
  await login(page, member.email, password);
  await openDetail(page, appointment.id);

  const invoice = detail(page).getByTestId("appointment-invoice");
  // Drawn, disabled, and naming its reason - the bill exists and the footer says so.
  await expect(invoice).toBeDisabled();
  await expect(invoice).toHaveAttribute("title", "You do not have permission to view invoices");
  await expect(invoice).not.toHaveClass(/\bprimary\b/);
  // The slot passes to the next enabled action on a completed visit: the sheet.
  await expect(detail(page).getByTestId("appointment-ticket")).toHaveClass(/\bprimary\b/);
  await expect(detail(page).locator("footer .primary")).toHaveCount(1);
});

test("the groomer pencil clears 4.5:1 at rest, on hover, on focus and when refused",
  async ({ page, request, tenant }) => {
    const appointment = await createAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    const pencil = detail(page).getByTestId("appointment-groomer-edit");
    await expect(pencil).toBeEnabled();
    // It is a drawn path, not a font character, so the ink measured on the button is the ink
    // the glyph is stroked in.
    await expect(pencil.locator("svg.edit-glyph")).toBeVisible();

    const rest = await paint(pencil);
    expect(contrastRatio(rest.ink, rest.fill), `rest ${rest.ink} on ${rest.fill}`).toBeGreaterThanOrEqual(4.5);

    await pencil.hover();
    const hover = await paint(pencil);
    expect(hover.fill, "hover changes the fill").not.toBe(rest.fill);
    expect(contrastRatio(hover.ink, hover.fill), `hover ${hover.ink} on ${hover.fill}`).toBeGreaterThanOrEqual(4.5);

    // Keyboard modality first, so the programmatic focus that follows is :focus-visible.
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await pencil.focus();
    const focus = await paint(pencil);
    expect(focus.focusVisible, "the focus rule is the one being measured").toBe(true);
    expect(contrastRatio(focus.ink, focus.fill), `focus ${focus.ink} on ${focus.fill}`).toBeGreaterThanOrEqual(4.5);

    // REFUSED: the same control for a groomer looking at a visit that is not theirs - the member
    // is linked to no employee, so the scope refuses it. Disabled, with its reason, and still
    // legible - a control whose job while disabled is to be found and to explain.
    const member = await createMember(request, `groomer-pencil+${tenant.runId}@pawsh-test.example`, GROOMER_PRESET);
    // `login()` clears the session cookie and starts from the sign-in page.
    await login(page, member.email, password);
    await openDetail(page, appointment.id);
    const refused = detail(page).getByTestId("appointment-groomer-edit");
    await expect(refused).toBeDisabled();
    await expect(refused).toHaveAttribute("title", "This appointment is assigned to another groomer");
    const disabled = await paint(refused);
    expect(contrastRatio(disabled.ink, disabled.fill), `disabled ${disabled.ink} on ${disabled.fill}`).toBeGreaterThanOrEqual(4.5);
  });

test("Adjust services names the pet first and keeps the rabies status at its own size",
  async ({ page, request, tenant }) => {
    // Rocky carries a safety alert, behaviour and medical notes, and no rabies record.
    const appointment = await createAppointment(request, tenant, {
      customerId: tenant.rockyCustomerId, petId: tenant.rockyPetId
    });
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);
    await detail(page).getByTestId("appointment-adjust-services").click();

    const modal = page.getByTestId("modal");
    await expect(modal).toBeVisible();
    const context = modal.getByTestId("modal-pet-context");
    await expect(context).toBeVisible();
    await expect(context.getByTestId("modal-pet-name")).toHaveText("Rocky");
    await expect(context).toContainText("German Shepherd");

    // Every safety fact is still there, beneath the identity, and the alarm is the alarm.
    const safety = context.getByTestId("safety-context");
    await expect(safety).toContainText("May snap during nail handling.");
    await expect(safety).toContainText("Nervous around paws.");
    await expect(safety).toContainText("Mild hip stiffness.");
    await expect(safety).toHaveClass(/has-alarm/u);

    // THE PILL IS A PILL AGAIN. The grid used to stretch it to the notes' height - the "large,
    // off-centre bubble" - so its height is the assertion, and it sits on the identity line.
    const pill = context.getByTestId("rabies-appointment-status");
    await expect(pill).toHaveText("Rabies needed");
    const [pillBox, nameBox, safetyBox] = await Promise.all([
      pill.boundingBox(), context.getByTestId("modal-pet-name").boundingBox(), safety.boundingBox()
    ]);
    expect(pillBox!.height, "rabies pill height").toBeLessThan(36);
    expect(Math.abs((pillBox!.y + pillBox!.height / 2) - (nameBox!.y + nameBox!.height / 2)), "pill centred on the name line").toBeLessThan(12);
    expect(safetyBox!.y, "care notes sit beneath the identity").toBeGreaterThan(nameBox!.y + nameBox!.height - 1);

    // The block spans the dialog rather than sharing a row with the first service section.
    const [contextBox, fields] = await Promise.all([context.boundingBox(), modal.locator("#modal-fields").boundingBox()]);
    expect(contextBox!.width).toBeGreaterThan(fields!.width * 0.9);
  });

test("compact controls are compact on a fine pointer", async ({ page, request, tenant }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "fine-pointer measurement belongs to the desktop project");
  const appointment = await createAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await openNavigation(page);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");

  // Representative calendar controls, not the appointment surface's own patch: the fix is the
  // shared rule, and the calendar toolbar is where QA saw the bulk.
  for (const selector of ["#calendar-today", "#calendar-prev-week", "#calendar-next-week"]) {
    const box = await page.locator(selector).boundingBox();
    expect(box!.height, selector).toBeLessThanOrEqual(32);
  }
  // The one booking door is `.compact` too, and still a full target for the pointer in use.
  await expectTouchTarget(page.getByTestId("new-action-trigger"));

  await page.locator(`[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
  for (const testid of ["appointment-ticket", "appointment-check-in", "appointment-cancel"]) {
    const box = await detail(page).getByTestId(testid).boundingBox();
    expect(box!.height, testid).toBeLessThanOrEqual(32);
  }
});

test("@responsive compact controls keep the 44px floor on a coarse pointer, footer included",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, "the coarse-pointer floor is exercised by the touch profiles");
    const appointment = await createAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    await openNavigation(page);
    await page.getByTestId("nav-calendar").click();
    await page.waitForLoadState("networkidle");
    // Every control paints at 36px (32 compact) and reaches 44 through the shared hit area, on a
    // phone and on a tablet alike, so it is measured as what a finger can press.
    await expectEffectiveTarget(page.locator("#calendar-today"));
    await revealAppointmentOnCalendar(page, appointment.id);
    for (const selector of ["#calendar-prev-week", "#calendar-next-week"]) {
      await expectEffectiveTarget(page.locator(selector));
    }
    await page.locator(`[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();
    await expect(detail(page)).toBeVisible();
    // The footer's actions on a phone: a 40px primary on its own row and 32px controls under it,
    // every one still a full target. Nothing here lost a finger's reach with the shared rule.
    for (const testid of ["appointment-check-in", "appointment-ticket", "appointment-cancel", "appointment-no-show"]) {
      await expectEffectiveTarget(detail(page).getByTestId(testid));
    }
  });
