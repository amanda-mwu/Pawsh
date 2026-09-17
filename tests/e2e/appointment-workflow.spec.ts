import { test, expect, login, createAppointment } from "./fixtures/tenant.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { revealAppointmentOnCalendar } from "./helpers/calendar.js";

/**
 * OPENING AN APPOINTMENT IS NOT GATED BY CHECKING THE PET IN.
 *
 * A scheduled visit used to open onto five identical grey pills and no primary action at all -
 * Cancel, No-show, Book Again, Print, Ticket. Adjust services was withheld although the route has
 * always accepted `scheduled`, and checking the pet in existed ONLY on the calendar card, so an
 * operator who had opened the appointment to read it had to close it again, find the card, and
 * press the small control on that. The screen they opened to work from was a screen they could
 * only read.
 *
 * Three things are separate and this walk keeps them apart:
 *
 *   ACCESS      who may open, read and edit the visit. Not a function of lifecycle.
 *   LIFECYCLE   scheduled -> checked_in -> in_service -> completed.
 *   MONEY       whether a bill may be raised, which is `checked_in` and `completed` only.
 *
 * WHY THIS IS A BROWSER SPEC. What the footer DRAWS per status is held deterministically in
 * `tests/ui/checkout-eligibility.test.ts` against the real `derive()`. What cannot be asserted
 * there: that one press actually persists the transition, that the surface updates under the
 * operator's hand without being closed and reopened, and that nothing financial happened.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");
const at = (page: Page, testid: string): Locator => detail(page).getByTestId(testid);

async function moveTo(api: APIRequestContext, appointmentId: string, version: number, status: string) {
  const response = await api.post(`/api/appointments/${appointmentId}/transition`, {
    data: { status, version }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { version: number }).version;
}

async function visit(api: APIRequestContext, appointmentId: string): Promise<{
  status: string; notes: string | null; invoiceId: string | null; services: { name: string }[];
}> {
  const response = await api.get(`/api/appointments/${appointmentId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as {
    status: string; notes: string | null; invoiceId: string | null; services: { name: string }[];
  };
  return {
    status: payload.status, notes: payload.notes ?? null,
    invoiceId: payload.invoiceId ?? null, services: payload.services ?? []
  };
}

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await revealAppointmentOnCalendar(page, appointmentId);
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

/** Every request that could raise a bill or record a tender. */
function watchMoney(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() !== "POST") return;
    const path = new URL(outgoing.url()).pathname;
    if (/\/checkout$/u.test(path) || /\/payments$/u.test(path)) seen.push(path);
  });
  return seen;
}

test("a scheduled visit opens as a work surface, and Check In is one press",
  async ({ page, request, tenant }) => {
    const appointment = await createAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    const money = watchMoney(page);
    await openDetail(page, appointment.id);

    // ── WHAT THE VISIT IS WAITING FOR, AND NOTHING IT IS NOT ───────────────────────────────────
    await expect(at(page, "appointment-check-in")).toBeVisible();
    await expect(at(page, "appointment-check-in")).toHaveClass(/primary/u);
    await expect(detail(page).locator("footer .primary")).toHaveCount(1);
    await expect(at(page, "appointment-take-payment")).toHaveCount(0);
    await expect(at(page, "appointment-ready")).toHaveCount(0);

    // ── AND IT IS EDITABLE WHERE THE ROUTE ALLOWS, BEFORE THE PET ARRIVES ──────────────────────
    await expect(at(page, "appointment-adjust-services")).toBeVisible();
    await expect(at(page, "appointment-adjust-services")).toBeEnabled();
    await expect(at(page, "appointment-groomer-edit")).toBeVisible();
    // The appointment note offers Add by name when there is none to edit.
    await expect(at(page, "appointment-note-edit")).toHaveText("Add");
    // The service note says why it is not open yet rather than showing a bare "No service note."
    await expect(at(page, "appointment-service-note-pending"))
      .toContainText("opens when the pet is checked in");

    // ── ONE PRESS, NO FORM ────────────────────────────────────────────────────────────────────
    await at(page, "appointment-check-in").click();

    // The surface updated under the operator's hand: it was never closed, and the footer now
    // offers what a checked-in visit offers.
    await expect(detail(page)).toBeVisible();
    await expect(at(page, "appointment-ready")).toBeVisible();
    await expect(at(page, "appointment-check-in")).toHaveCount(0);

    const after = await visit(request, appointment.id);
    expect(after.status).toBe("checked_in");
    // CHECKING IN IS NOT A FINANCIAL ACT.
    expect(money).toEqual([]);
    expect(after.invoiceId).toBeNull();
  });

test("a scheduled visit takes an appointment note from empty, and keeps it",
  async ({ page, request, tenant }) => {
    const appointment = await createAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    // Empty means Add, not a hunt for an edit mode.
    await expect(at(page, "appointment-note-edit")).toHaveText("Add");
    await at(page, "appointment-note-edit").click();

    const typed = "Owner wants the beard left long this time.";
    await at(page, "appointment-note-record-input").fill(typed);
    await at(page, "appointment-note-save").click();

    await expect(at(page, "appointment-booking-note")).toHaveText(typed);
    // And the control now says Edit, because there is something to edit.
    await expect(at(page, "appointment-note-edit")).toHaveText("Edit");
    expect((await visit(request, appointment.id)).notes).toBe(typed);
  });

test("the services of a scheduled visit can be changed from the visit itself",
  async ({ page, request, tenant }) => {
    // The route has always accepted `scheduled`; the surface withheld the control, so the status
    // where adding a service is most ordinary was the one with no way to do it.
    const appointment = await createAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    await at(page, "appointment-adjust-services").click();
    const modal = page.locator("#modal-fields");
    await expect(modal).toBeVisible();

    // The canonical tenant catalog, not a list this screen invented: every service the salon has
    // is offered, with the one already booked already ticked.
    const boxes = modal.locator('input[name="serviceIds"]');
    expect(await boxes.count()).toBeGreaterThan(1);
    await expect(modal.locator('input[name="serviceIds"]:checked')).toHaveCount(1);

    const before = (await visit(request, appointment.id)).services.length;
    // A service THIS groomer offers. The picker lists the whole tenant catalog, so choosing one
    // the assigned groomer is not set up for is refused by the route on submit - which is
    // existing behaviour and not what this walk is about.
    await modal.getByRole("checkbox", { name: /^Nail Trim \$20\.00/u }).check();
    await page.getByTestId("modal-submit").click();
    await expect(modal).toBeHidden();

    await expect(async () => {
      expect((await visit(request, appointment.id)).services.length).toBe(before + 1);
    }).toPass();
  });

test("an in-service visit is completed from the visit, and is never offered a bill",
  async ({ page, request, tenant }) => {
    const appointment = await createAppointment(request, tenant);
    const checkedIn = await moveTo(request, appointment.id, appointment.version, "checked_in");
    await moveTo(request, appointment.id, checkedIn, "in_service");

    await login(page, tenant.ownerEmail);
    const money = watchMoney(page);
    await openDetail(page, appointment.id);

    // The calendar card's own word for this transition, not a second one.
    await expect(at(page, "appointment-complete")).toBeVisible();
    await expect(at(page, "appointment-complete")).toHaveClass(/primary/u);
    await expect(at(page, "appointment-ready")).toHaveCount(0);
    await expect(at(page, "appointment-take-payment")).toHaveCount(0);
    await expect(detail(page).locator("footer .primary")).toHaveCount(1);
    // Still a work surface: the services and both notes are reachable, each note with its own
    // editor and no footer Save.
    await expect(at(page, "appointment-adjust-services")).toBeEnabled();
    await expect(at(page, "appointment-service-note-edit")).toBeEnabled();
    await expect(at(page, "appointment-note-edit")).toBeEnabled();
    await expect(at(page, "appointment-save")).toHaveCount(0);

    await at(page, "appointment-complete").click();
    await expect(async () => {
      expect((await visit(request, appointment.id)).status).toBe("completed");
    }).toPass();
    expect(money).toEqual([]);
  });

test("one ticket action, and no second route to the same document",
  async ({ page, request, tenant }) => {
    const appointment = await createAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    // `Print` produced an agenda extract and `Ticket` the work sheet, in identical grey pills; a
    // header icon was bound to the very same closure as `Ticket`.
    await expect(at(page, "appointment-print")).toHaveCount(0);
    await expect(page.getByTestId("appointment-ticket-print")).toHaveCount(0);
    const ticket = at(page, "appointment-ticket");
    await expect(ticket).toBeVisible();
    await expect(ticket).toHaveText("Print Ticket");

    await ticket.click();
    await expect(page.getByTestId("ticket-document")).toBeVisible();
  });

test("@responsive the footer keeps its hierarchy on a desk and on a phone",
  async ({ page, request, tenant }) => {
    const appointment = await createAppointment(request, tenant);
    const checkedIn = await moveTo(request, appointment.id, appointment.version, "checked_in");
    expect(checkedIn).toBeGreaterThan(0);

    await login(page, tenant.ownerEmail);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDetail(page, appointment.id);

    const geometry = async () => page.evaluate(() => {
      const foot = document.querySelector("#appointment-detail .surface-foot") as HTMLElement;
      const lead = foot.querySelector(".surface-foot-lead") as HTMLElement;
      const utility = foot.querySelector(".surface-foot-utility") as HTMLElement;
      const box = (node: HTMLElement) => node.getBoundingClientRect();
      const buttons = [...foot.querySelectorAll("button")] as HTMLElement[];
      return {
        leftOfLead: Math.round(box(lead).left),
        rightOfUtility: Math.round(box(utility).right),
        footHeight: Math.round(box(foot).height),
        shortest: Math.min(...buttons.map((node) => Math.round(box(node).height))),
        primaries: foot.querySelectorAll(".primary").length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });

    const desk = await geometry();
    // TWO ZONES WITH AIR BETWEEN THEM, so the work is not the tail of a row of pills.
    expect(desk.leftOfLead).toBeGreaterThan(desk.rightOfUtility);
    expect(desk.primaries, "exactly one dominant control").toBe(1);
    expect(desk.overflow, "the page must never scroll sideways").toBeLessThanOrEqual(0);

    await page.setViewportSize({ width: 390, height: 844 });
    const phone = await geometry();
    expect(phone.primaries, "still exactly one dominant control").toBe(1);
    expect(phone.overflow, "the page must never scroll sideways").toBeLessThanOrEqual(0);
    // Every control stays a real target on a phone, including the quiet ones.
    expect(phone.shortest).toBeGreaterThanOrEqual(32);
    // And the work is still reachable without hunting.
    await expect(at(page, "appointment-take-payment")).toBeVisible();
    await expect(at(page, "appointment-ready")).toBeVisible();
  });
