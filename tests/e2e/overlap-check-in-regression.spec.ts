import { test, expect, login, createAppointment, createMember, password } from "./fixtures/tenant.js";
import { openBooking, chooseBookingClient, chooseBookingPet, fillBooking } from "./helpers/booking.js";
import { permissionPresets } from "@pawsh/domain";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * THE CHARLIE REGRESSION - release-blocking.
 *
 * Human QA: a manager booked a second dog over Charlie's slot, opened Charlie, pressed Check In,
 * and what came back was wrong - the press had to be repeated, the surface did not redraw as
 * checked in, and the service note stayed shut. Overlaps are the ordinary case in a salon, so the
 * scenario is held here exactly as QA ran it:
 *
 *   THE MANAGER BOOKS B OVER CHARLIE DIRECTLY. No "Book anyway": the manager holds the key, the
 *       server records the overlap, and the calendar draws both SIDE BY SIDE - two lanes in the
 *       column, the way two blocks are two bands - so neither card covers the other.
 *   ONE PRESS CHECKS CHARLIE IN. One transition request, the server says `checked_in`, the surface
 *       stays open and redraws as checked in, and the service note's Add is offered at once.
 *   THE NOTE PERSISTS. Written, saved, and read back after the surface is closed and reopened.
 *   THE CARD MENU DOES THE SAME. B is checked in from the calendar card's own menu, which goes
 *       through the check-in dialog rather than the surface, and lands in the same state.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail");

async function visit(api: APIRequestContext, appointmentId: string): Promise<{ status: string; operationalNotes: string | null }> {
  const response = await api.get(`/api/appointments/${appointmentId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { status: string; operationalNotes: string | null };
}

async function openCalendar(page: Page): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

async function openSurface(page: Page, appointmentId: string): Promise<void> {
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

/** Two cards in one column share it side by side: neither covers any part of the other. */
async function expectSideBySide(page: Page, first: string, second: string): Promise<void> {
  const a = await page.locator(`[data-appointment-id="${first}"]`).first().boundingBox();
  const b = await page.locator(`[data-appointment-id="${second}"]`).first().boundingBox();
  expect(a && b, "both cards are drawn").toBeTruthy();
  const apart = a!.x + a!.width <= b!.x + 1 || b!.x + b!.width <= a!.x + 1;
  expect(apart, `cards overlap horizontally: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(true);
  for (const id of [first, second]) {
    await expect(page.locator(`[data-appointment-id="${id}"]`).first()).toHaveAttribute("data-card-lanes", "2");
  }
}

test("a manager books over Charlie, checks Charlie in with one press, and the service note sticks",
  async ({ page, request, tenant }) => {
    const charlie = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const manager = await createMember(request, `manager+${tenant.runId}@pawsh-test.example`, [...permissionPresets.manager!]);
    await login(page, manager.email, password);
    await openCalendar(page);

    // B OVER CHARLIE, DIRECTLY. Rocky at 09:00 on the same groomer; no confirmation is drawn.
    await openBooking(page);
    await chooseBookingClient(page, tenant.rockyCustomerId);
    await chooseBookingPet(page, tenant.rockyPetId);
    await fillBooking(page, { employeeId: tenant.employeeId, startAt: `${tenant.anchor}T09:00` });
    const created = page.waitForResponse((response) =>
      response.url().endsWith("/api/appointments") && response.request().method() === "POST");
    await page.getByTestId("booking-submit").click();
    const b = (await (await created).json()) as { id: string; conflictOverridden?: boolean };
    expect(b.conflictOverridden).toBe(true);
    await expect(page.getByTestId("booking-dialog")).toBeHidden();
    await expect(page.getByTestId("confirm-conflict-override")).toHaveCount(0);
    await expect(page.locator(`[data-appointment-id="${charlie.id}"]`).first()).toBeVisible();
    await expect(page.locator(`[data-appointment-id="${b.id}"]`).first()).toBeVisible();
    // Side by side, not one over the other: which card was on top used to depend on the order the
    // server returned them in, and the one underneath could not be opened from its centre.
    await expectSideBySide(page, charlie.id, b.id);

    // ONE PRESS. Every transition request is counted, so "once" is a fact about the wire.
    const transitions: string[] = [];
    await page.route(`**/api/appointments/${charlie.id}/transition`, async (route) => {
      transitions.push((route.request().postDataJSON() as { status: string }).status);
      await route.continue();
    });
    await openSurface(page, charlie.id);
    await expect(detail(page).getByTestId("appointment-status")).toContainText(/scheduled/iu);
    await detail(page).getByTestId("appointment-check-in").click();

    // The server says so, the surface stayed open and redrew, and the note is open for writing.
    await expect.poll(() => visit(request, charlie.id).then((each) => each.status)).toBe("checked_in");
    expect(transitions).toEqual(["checked_in"]);
    await expect(detail(page)).toBeVisible();
    await expect(detail(page).getByTestId("appointment-status")).toContainText(/checked in/iu);
    await expect(detail(page).getByTestId("appointment-check-in")).toHaveCount(0);
    await expect(detail(page).getByTestId("appointment-ready")).toBeVisible();
    const add = detail(page).getByTestId("appointment-service-note-edit");
    await expect(add).toBeVisible();
    await expect(add).toBeEnabled();
    await expect(add).toHaveText("Add");
    await expect(detail(page).getByTestId("appointment-service-note-pending")).toHaveCount(0);

    // THE NOTE. Written here, saved here, and still here after a close and reopen.
    await add.click();
    await detail(page).getByTestId("appointment-service-note-input").fill("Matted behind the ears; took it slowly.");
    await detail(page).getByTestId("appointment-service-note-save").click();
    await expect(page.locator("#toast")).toContainText("Service note saved");
    await expect(detail(page).getByTestId("appointment-service-note")).toHaveText("Matted behind the ears; took it slowly.");
    expect((await visit(request, charlie.id)).operationalNotes).toBe("Matted behind the ears; took it slowly.");
    await detail(page).locator("[data-surface-close]").click();
    await expect(detail(page)).toBeHidden();
    await openSurface(page, charlie.id);
    await expect(detail(page).getByTestId("appointment-status")).toContainText(/checked in/iu);
    await expect(detail(page).getByTestId("appointment-service-note")).toHaveText("Matted behind the ears; took it slowly.");
    expect(transitions).toEqual(["checked_in"]);
    await detail(page).locator("[data-surface-close]").click();
    await expect(detail(page)).toBeHidden();

    // THE CARD MENU PATH, for B. The menu's Check in opens the check-in dialog; one Save, one
    // transition, and the card - and the surface behind it - agree with the server.
    const bTransitions: string[] = [];
    await page.route(`**/api/appointments/${b.id}/transition`, async (route) => {
      bTransitions.push((route.request().postDataJSON() as { status: string }).status);
      await route.continue();
    });
    const card = page.locator(`[data-appointment-id="${b.id}"]`).first();
    await card.getByRole("button", { name: /Appointment actions for/ }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "Check in", exact: true }).filter({ visible: true }).click();
    await expect(page.getByTestId("modal")).toBeVisible();
    await expect(page.locator("#modal-title")).toHaveText("Check in appointment");
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();
    await expect.poll(() => visit(request, b.id).then((each) => each.status)).toBe("checked_in");
    expect(bTransitions).toEqual(["checked_in"]);
    await expect(page.locator(`[data-appointment-id="${b.id}"]`).first()).toHaveClass(/status-checked_in/u);
    await openSurface(page, b.id);
    await expect(detail(page).getByTestId("appointment-status")).toContainText(/checked in/iu);
    await expect(detail(page).getByTestId("appointment-service-note-edit")).toHaveText("Add");
  });
