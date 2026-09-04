import {
  test,
  expect,
  login,
  createAppointment,
  completeAppointment,
  createMember,
  ownerPermissions
} from "./fixtures/tenant.js";
import type { TenantFixture } from "./fixtures/tenant.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * The appointment detail surface — level 1 of the appointment stack.
 *
 * The surface is its own full-screen <dialog>, not the shared #modal and not a route. Those two
 * choices are what these specs are actually about: the shared dialog cannot host a surface that
 * opens further dialogs of its own (showModal() on an open dialog throws, which is why the old
 * detail had to close itself before Move or Adjust services), and a route would re-render the
 * calendar on every dismissal, losing the horizontal scroll offset and the groomer filter that a
 * front desk sets once and opens appointments against all day.
 *
 * Nothing here is mocked except one deliberate server failure, which exists to prove the client
 * rail can fail without taking the times, services and money down with it.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail");

async function openFromCalendar(page: Page, appointmentId: string): Promise<Locator> {
  await page.getByTestId("nav-calendar").click();
  // The calendar renders twice on entry (the week, then the month it backfills), so the card is
  // replaced under anything that clicked the first copy — and it is replaced again by any refresh
  // that lands while the surface is open. Focus restoration resolves the card by its appointment
  // id for that reason, so the assertion below holds whichever copy is on screen; this wait is
  // only so the click has a card to land on.
  await page.waitForLoadState("networkidle");
  const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
  await card.locator(".calendar-open").first().click();
  await expect(detail(page)).toBeVisible();
  return card;
}

async function transition(
  request: APIRequestContext,
  appointment: { id: string; version: number },
  status: string
): Promise<number> {
  const response = await request.post(`/api/appointments/${appointment.id}/transition`, {
    data: { status, version: appointment.version }
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).version;
}

test("the surface is its own dialog, and the checkout and ticket levels stand ready and closed", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, tenant.ownerEmail);
  const card = await openFromCalendar(page, appointment.id);

  // Level 1 is a dedicated element. The shared dialog is untouched and free to host this
  // surface's own children.
  await expect(page.getByTestId("appointment-detail-surface")).toBeVisible();
  await expect(page.getByTestId("modal")).toBeHidden();
  // Levels 2 and 3 exist from the first render so the primitive has somewhere to push to, and a
  // SCHEDULED appointment opens neither on arrival. Check Out is offered only once the visit is
  // completed, so its footer button is absent here — but the Ticket is a printable work sheet
  // rather than a record of what happened, so its entry point is the header's print icon and it
  // is offered at every stage. `tests/e2e/ticket-surface.spec.ts` is where level 3 is driven open.
  await expect(page.getByTestId("checkout-surface")).toBeHidden();
  await expect(page.getByTestId("ticket-surface")).toBeHidden();
  await expect(page.getByTestId("appointment-ticket")).toHaveCount(0);
  await expect(page.getByTestId("appointment-ticket-print")).toBeVisible();

  await expect(page.getByTestId("appointment-reference"))
    .toContainText(`Appointment #${appointment.id.slice(0, 8)}`);
  // Pawsh's chip, not a binary Unpaid: an appointment with no invoice is unbilled, which reads
  // very differently from unpaid.
  await expect(page.getByTestId("appointment-billing")).toHaveText("Not invoiced");
  await expect(page.getByTestId("appointment-status")).toHaveText("scheduled");
  await expect(page.getByTestId("appointment-groomer")).toHaveText("Grace Groomer");
  await expect(page.getByTestId("appointment-service-row")).toHaveCount(1);

  // A scheduled appointment cannot be checked out and has no service note to write, so neither
  // control is drawn. Absent, not disabled.
  await expect(page.getByTestId("appointment-take-payment")).toHaveCount(0);
  await expect(page.getByTestId("appointment-save")).toHaveCount(0);
  await expect(page.getByTestId("appointment-cancel")).toBeVisible();
  await expect(page.getByTestId("appointment-no-show")).toBeVisible();
  await expect(page.getByTestId("appointment-book-again")).toBeVisible();
  await expect(page.getByTestId("appointment-print")).toBeVisible();

  // Escape is the browser's, routed through the one dismissal every close uses so the history
  // depth and the screen stay in agreement.
  await page.keyboard.press("Escape");
  await expect(detail(page)).toBeHidden();
  await expect(card.locator(".calendar-open").first()).toBeFocused();
});

test("the lifecycle strip reports derived times and says so only while something is missing", async ({
  page,
  request,
  tenant
}) => {
  // completeAppointment() books the 09:00 slot, so the untouched one takes a later one: two
  // appointments on the same groomer at the same time is a conflict the server is right to refuse.
  const finished = await completeAppointment(request, tenant);
  const scheduled = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T13:00` });

  await login(page, tenant.ownerEmail);
  await openFromCalendar(page, scheduled.id);
  // Nothing has been recorded, so all three read as absent — and one line explains why they are
  // blank, which is what stops two empty values reading as a form nobody filled in.
  await expect(page.getByTestId("lifecycle-in")).toHaveText("Checked in: not recorded");
  await expect(page.getByTestId("lifecycle-out")).toHaveText("Checked out: not recorded");
  await expect(page.getByTestId("lifecycle-duration")).toHaveText("Duration: not recorded");
  await expect(page.getByTestId("lifecycle-note")).toBeVisible();
  // The times are derived, so there is nothing an edit could write to and no pencil is offered.
  await expect(page.getByTestId("appointment-lifecycle").getByRole("button")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await openFromCalendar(page, finished.id);
  await expect(page.getByTestId("lifecycle-in")).not.toContainText("not recorded");
  await expect(page.getByTestId("lifecycle-out")).not.toContainText("not recorded");
  // "Actual" was the old label and said nothing; a duration under an hour is the plain count.
  await expect(page.getByTestId("lifecycle-duration")).toHaveText(/^Duration: \d+ min$/);
  // Both moments are on the record, so the explanation has nothing to explain.
  await expect(page.getByTestId("lifecycle-note")).toHaveCount(0);
});

test("one history entry per level: Back dismisses the surface and a reload lands with it closed", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, tenant.ownerEmail);
  await openFromCalendar(page, appointment.id);

  // Back closes exactly one level rather than navigating the view underneath it, and the calendar
  // is the one that was already on screen — same view, same week selection, never re-entered.
  await page.goBack();
  await expect(detail(page)).toBeHidden();
  await expect(page.getByTestId("calendar")).toBeVisible();
  await expect(page.locator("#calendar-view-select")).toHaveValue("week");

  await page.locator(`[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
  // A reload at any depth lands on the view beneath with the stack closed: popstate reconciles
  // DOWN, so a restored entry can never re-open a surface nobody asked for.
  await page.reload();
  await expect(page.getByTestId("appointment-detail-surface")).toBeHidden();
});

test("the rail is the client's own summary column, and a rail row replaces the surface", async ({
  page,
  request,
  tenant
}) => {
  const first = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  const second = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T13:00` });
  await login(page, tenant.ownerEmail);
  await openFromCalendar(page, first.id);

  const rail = page.getByTestId("appointment-client-rail");
  // clientSummaryMarkup() verbatim, with the rail's own tab set — no third variant, no fork.
  await expect(rail.getByRole("tab")).toHaveText(["Pets", "Appointments", "Cards"]);
  await expect(rail).toContainText("Emma Johnson");
  await expect(rail.getByTestId("client-panel-pets")).toContainText("Charlie");

  await rail.getByTestId("client-tab-appointments").click();
  await rail
    .getByTestId("client-appointment-row")
    .filter({ hasText: "1:00" })
    .click();

  // Replaced, not stacked. One surface is open, showing the other appointment, and the history
  // depth has not moved: a single Back is still the whole way out.
  await expect(page.getByTestId("appointment-reference"))
    .toContainText(`Appointment #${second.id.slice(0, 8)}`);
  await expect(page.getByTestId("appointment-detail-surface")).toHaveCount(1);
  await page.goBack();
  await expect(detail(page)).toBeHidden();
  await expect(page.getByTestId("calendar")).toBeVisible();
});

test("Move opens on top of the surface instead of replacing it, and the surface redraws behind it", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, tenant.ownerEmail);
  await openFromCalendar(page, appointment.id);

  await page.getByTestId("appointment-groomer-edit").click();
  await expect(page.getByTestId("modal")).toBeVisible();
  // The whole point of the dedicated dialog: the operator can still see the appointment they are
  // rescheduling. The old detail had to close itself first and left them looking at the calendar.
  await expect(detail(page)).toBeVisible();

  await page.locator('#modal input[name="startAt"]').fill(`${tenant.anchor}T13:30`);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  // Still open, and redrawn from what the server actually did rather than from what was asked.
  await expect(detail(page)).toBeVisible();
  await expect(page.locator(".surface-subhead")).toContainText("1:30");
});

test("a terminal appointment offers only what still means something", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await transition(request, appointment, "cancelled");
  await login(page, tenant.ownerEmail);
  await openFromCalendar(page, appointment.id);

  await expect(page.getByTestId("appointment-status")).toHaveText("cancelled");
  await expect(page.getByTestId("appointment-print")).toBeVisible();
  await expect(page.getByTestId("appointment-close")).toBeVisible();
  for (const control of [
    "appointment-cancel",
    "appointment-no-show",
    "appointment-book-again",
    "appointment-take-payment",
    "appointment-save",
    "appointment-groomer-edit",
    "appointment-adjust-services",
    // The footer's own Ticket button is a settled-visit control and a cancelled visit never
    // settles, so Close keeps the primary slot it gives up on a completed appointment. The
    // header's print icon is a different thing and is still there: see below.
    "appointment-ticket"
  ]) {
    await expect(page.getByTestId(control), control).toHaveCount(0);
  }
  // A cancelled visit still has a work sheet. Nothing on it asserts the visit happened, and an
  // operator reprinting the sheet for a cancellation they are chasing is an ordinary thing to do.
  await expect(page.getByTestId("appointment-ticket-print")).toBeVisible();
  // Nothing can be written to a cancelled appointment, so the note is text rather than a field.
  await expect(page.getByTestId("appointment-note").locator("textarea")).toHaveCount(0);

  await page.getByTestId("appointment-close").click();
  await expect(detail(page)).toBeHidden();
});

test("Take Payment opens the existing checkout dialog, and is absent without the permission", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await completeAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await openFromCalendar(page, appointment.id);

  await page.getByTestId("appointment-take-payment").click();
  // Check Out is level 2 of the same stack, pushed over the detail rather than opened in the
  // shared dialog. The detail is still there underneath, inert, and one Escape comes back to it.
  const checkout=page.getByTestId("checkout-surface");
  await expect(checkout).toBeVisible();
  await expect(page.getByTestId("checkout-reference"))
    .toContainText(`Check Out · #${appointment.id.slice(0,8)}`);
  await expect(page.getByTestId("modal")).toBeHidden();
  await expect(detail(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(checkout).toBeHidden();
  await expect(detail(page)).toBeVisible();
  // One level per history entry, still: Back from the detail lands on the calendar, not on the
  // checkout that was just dismissed.
  await page.goBack();
  await expect(detail(page)).toBeHidden();
  await expect(page.getByTestId("calendar")).toBeVisible();

  // Withheld rather than offered and refused — the rule calendarAction() already follows.
  const member = await createMember(
    request,
    `no-checkout-${tenant.runId}@pawsh-test.example`,
    ownerPermissions.filter((permission: string) => permission !== "checkout.perform")
  );
  await login(page, member.email);
  await openFromCalendar(page, appointment.id);
  await expect(page.getByTestId("appointment-take-payment")).toHaveCount(0);
  await expect(page.getByTestId("appointment-print")).toBeVisible();
});

test("the client rail can fail without taking the main column with it", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, tenant.ownerEmail);
  await page.route("**/api/customers/*/history", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Not found"}' })
  );
  await openFromCalendar(page, appointment.id);

  const rail = page.getByTestId("appointment-client-rail");
  await expect(rail.getByTestId("appointment-client-retry")).toBeVisible();
  // Times, services and money are what this surface was opened for, and they are unaffected.
  await expect(page.getByTestId("appointment-groomer")).toHaveText("Grace Groomer");
  await expect(page.getByTestId("appointment-service-row")).toHaveCount(1);
  await expect(page.getByTestId("appointment-lifecycle")).toContainText("Checked in:");

  await page.unroute("**/api/customers/*/history");
  await rail.getByTestId("appointment-client-retry").click();
  await expect(rail.getByRole("tab")).toHaveText(["Pets", "Appointments", "Cards"]);
  await expect(rail).toContainText("Emma Johnson");
});

test("the surface preserves Activities, Photos and Report Cards", async ({
  page,
  request,
  tenant
}: {
  page: Page;
  request: APIRequestContext;
  tenant: TenantFixture;
}) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, tenant.ownerEmail);
  await openFromCalendar(page, appointment.id);

  // Three working features that appear nowhere in the reference the surface was drawn from. They
  // carry across intact rather than being dropped because a mock did not show them.
  const activity = page.getByTestId("appointment-activity");
  await expect(activity.locator("[data-activity-count]")).toHaveText(/^\(\d+\)$/);
  await activity.locator("summary").click();
  await expect(activity.locator(".activity-feed li").filter({ hasText: "Appointment created" }))
    .toHaveCount(1);
  await expect(page.getByTestId("appointment-photos").locator(".photo-pet summary"))
    .toContainText("Charlie");
  await expect(page.getByTestId("appointment-report-cards"))
    .toContainText("No report card for this visit yet");
  await expect(page.getByTestId("report-card-add")).toBeVisible();
});
