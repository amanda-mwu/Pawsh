import { test, expect, login, createMember, createAppointment, password } from "./fixtures/tenant.js";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * WHAT A GROOMER IS OFFERED ON THE CALENDAR, AND WHAT THEY ARE TOLD INSTEAD.
 *
 * Three defects met on one screen, and every one of them was reproduced by signing in as a groomer
 * and opening the calendar:
 *
 *   Every empty half-hour was a button announced as "create appointment". Pressing one opened
 *   `#slot-menu` — static markup with no gate — offering an enabled Add and an enabled Block. The
 *   menu is `position:fixed` and clamped to the viewport, so its `⊕` is the stray floating "+"
 *   that was reported. Pressing Add reached `openBookingDialog`, whose prefetch is refused: a 403,
 *   an unhandled rejection, and then nothing at all. No dialog, no toast, no explanation.
 *
 *   Opening any appointment fired three ungated client reads. All three 403'd, the rail claimed the
 *   record "could not be loaded", and its Retry re-sent the same three refusals forever.
 *
 *   Five controls on that appointment rendered as `""` and silently vanished, leaving a screen with
 *   nothing on it and no reason given.
 *
 * NOTHING HERE CHANGES A PRESET. The member below is created with exactly the seven permissions
 * `permissionPresets.groomer` holds, restated so that a change to the preset shows up here as a
 * disagreement rather than passing silently.
 *
 * The `page` fixture fails any test that produces a console error or an unhandled rejection, so
 * "no page error" is asserted on every one of these by construction — which is the half of the
 * booking defect that had no visible symptom at all.
 */
const GROOMER_PRESET = [
  "calendar.view", "appointments.view", "pets.view", "pets.care.view",
  "operations.check_in", "operations.perform_service", "operations.complete"
];

/**
 * A groomer OWNS the fixture visit only when their membership is the fixture employee's. The
 * operations routes and the surface both ask "is this appointment mine" now, so a member who is
 * a groomer in name but linked to no employee record can look and cannot press. Linking is one
 * PATCH on the employee. BACKEND-DEPENDENT: the surface reads its own id off `GET /api/me`.
 */
async function linkToEmployee(api: APIRequestContext, employeeId: string, membershipId: string): Promise<void> {
  const linked = await api.put(`/api/employees/${employeeId}`, { data: { membershipId } });
  expect(linked.ok(), await linked.text()).toBeTruthy();
}

async function calendar(page: Page): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

test("a groomer is offered no booking gesture anywhere on the grid", async ({
  page,
  request,
  tenant
}) => {
  const member = await createMember(request, `groomer+${tenant.runId}@pawsh-test.example`, GROOMER_PRESET);
  await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, member.email, password);
  await calendar(page);

  // The header's + New menu is the one door into booking, and it says why it is shut: disabled
  // with the missing keys named, so the grid's silence below is read as the same rule rather
  // than as the calendar being broken.
  await page.getByTestId("new-action-trigger").click();
  const newAppointment = page.getByTestId("new-action-menu").getByRole("menuitem", { name: "New Appointment" });
  await expect(newAppointment).toBeDisabled();
  await expect(newAppointment).toHaveAttribute("title", /appointments\.create/u);
  await page.keyboard.press("Escape");
  // And no second door: the toolbar no longer carries its own booking button.
  await expect(page.getByTestId("calendar-add-appointment")).toHaveCount(0);

  // THE GRID. Not one cell carries the hook `bindCalendarInteractions` binds the menu to, so
  // there is no press that can open it.
  await expect(page.locator(".week-slot[data-slot]")).toHaveCount(0);
  await expect(page.locator(".week-slot:not(.closed)").first()).toBeDisabled();
  // And nothing announces a booking it cannot make.
  await expect(page.getByRole("button", { name: /create appointment/i })).toHaveCount(0);

  // The day grid is the same grid by another layout, and had the same defect.
  await page.locator("#calendar-view-select").selectOption("day");
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".day-slot[data-slot]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /create appointment/i })).toHaveCount(0);

  // The month cell's `+` is the header's New Appointment in another place, and answers to the same gate.
  await page.locator("#calendar-view-select").selectOption("month");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-month-book-date]")).toHaveCount(0);
  await expect(page.locator(".calendar-month-day").first()).toBeVisible();

  // The menu itself never comes up — the floating "+" has nowhere to come from.
  await expect(page.getByTestId("slot-menu")).toBeHidden();
});

test("a receptionist keeps every one of those gestures", async ({ page, request, tenant }) => {
  // The other half of the gate. A rule that withheld the affordance from everyone would pass every
  // assertion in the test above and be a worse defect than the one being fixed.
  const member = await createMember(request, `front+${tenant.runId}@pawsh-test.example`, [
    "calendar.view", "appointments.view", "appointments.create", "appointments.edit",
    "appointments.cancel", "calendar.blocks_create", "calendar.blocks_edit",
    "customers.view", "customers.edit", "pets.view", "pets.edit", "pets.care.view",
    "operations.check_in", "checkout.perform", "payments.view"
  ]);
  await login(page, member.email, password);
  await calendar(page);

  await page.getByTestId("new-action-trigger").click();
  await expect(page.getByTestId("new-action-menu").getByRole("menuitem", { name: "New Appointment" })).toBeEnabled();
  await page.keyboard.press("Escape");
  const slot = page.locator(".week-slot[data-slot]").first();
  await slot.scrollIntoViewIfNeeded();
  await slot.click();

  const menu = page.getByTestId("slot-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("slot-menu-add")).toBeEnabled();
  await expect(page.getByTestId("slot-menu-block")).toBeEnabled();

  // And Add still opens the workspace, which is what the prefetch guard must not have cost.
  await page.getByTestId("slot-menu-add").click();
  await expect(page.getByTestId("booking-client-search")).toBeVisible();
});

test("a groomer's appointment says why it is inert instead of showing nothing", async ({
  page,
  request,
  tenant
}) => {
  const member = await createMember(request, `groomer-detail+${tenant.runId}@pawsh-test.example`, GROOMER_PRESET);
  await linkToEmployee(request, tenant.employeeId, member.membershipId);
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, member.email, password);
  await calendar(page);

  // Every read against the customer routes, recorded. There should be none: the rail reads the
  // appointment-scoped `GET /api/appointments/:id/client` instead, which the groomer may open.
  const clientReads: string[] = [];
  page.on("request", (event) => {
    const path = new URL(event.url()).pathname;
    if (/^\/api\/customers\//u.test(path)) clientReads.push(path);
  });

  await page.locator(`[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();
  const detail = page.getByTestId("appointment-detail");
  await expect(detail).toBeVisible();

  // THE RAIL IS DRAWN FOR THE GROOMER. BACKEND-DEPENDENT: `GET /api/appointments/:id/client`.
  // The same rail every role gets - identity, notes, the three tabs - with nothing financial in
  // it, and no read of a route this role cannot open.
  const rail = page.getByTestId("appointment-client-rail");
  await expect(rail).toContainText("Emma Johnson");
  await expect(rail.getByRole("tab")).toHaveText(["Pets", "Appointments", "Cards"]);
  await expect(page.getByTestId("appointment-client-retry")).toHaveCount(0);
  await expect(rail).not.toContainText("could not be loaded");
  expect(clientReads).toEqual([]);

  // THE CONTROLS. Drawn, disabled, and each naming the key it needs.
  for (const [testid, permission] of [
    ["appointment-groomer-edit", "appointments.edit"],
    ["appointment-note-edit", "appointments.edit"],
    ["appointment-adjust-services", "appointments.edit"],
    ["appointment-cancel", "appointments.cancel"],
    ["appointment-no-show", "appointments.cancel"]
  ]) {
    const control = detail.getByTestId(testid!);
    await expect(control, `${testid} vanished instead of explaining itself`).toBeVisible();
    await expect(control).toBeDisabled();
    await expect(control).toHaveAttribute("title", new RegExp(permission!.replace(".", "\\.")));
  }

  // AND THE OTHER HALF OF THE RULE, in the same browser. Check In is a STATE question: a
  // scheduled visit offers it, and this groomer holds `operations.check_in`, so it is drawn and
  // pressable. Ready for Pickup and Take Payment belong to statuses this visit is not in, so
  // they are absent rather than disabled - a control that could never apply here explains
  // nothing.
  await expect(detail.getByTestId("appointment-check-in")).toBeEnabled();
  await expect(detail.getByTestId("appointment-ready")).toHaveCount(0);
  await expect(detail.getByTestId("appointment-take-payment")).toHaveCount(0);

  // What the groomer CAN reach is untouched. The Ticket is the shop's work sheet, carries no money
  // and no permission gate, and is the reason this surface is still worth opening.
  await expect(detail.getByTestId("appointment-ticket")).toBeVisible();
});

test("a groomer checks a pet in and hands it back, both from the visit itself", async ({
  page,
  request,
  tenant
}) => {
  /*
   * HUMAN QA REPORTED READY FOR PICKUP AS UNAVAILABLE TO A GROOMER, AND IT NEVER WAS.
   *
   * The Groomer preset holds `operations.check_in`, `operations.perform_service` AND
   * `operations.complete` - it always has - so both of these controls are the groomer's to press.
   * What the report was actually about was that the footer gave them no weight: five identical
   * grey pills, and the one that moved the visit on was the fifth from the left. This walk pins
   * the capability so that a future change to the preset or to the gate has to break a test
   * rather than a shift.
   */
  const member = await createMember(request, `groomer-lifecycle+${tenant.runId}@pawsh-test.example`, GROOMER_PRESET);
  await linkToEmployee(request, tenant.employeeId, member.membershipId);
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T11:00` });
  await login(page, member.email, password);
  await calendar(page);
  await page.locator(`[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();

  const detail = page.getByTestId("appointment-detail-surface");
  await expect(detail).toBeVisible();

  // SCHEDULED: Check In is the one dominant control, and it is theirs.
  const checkIn = detail.getByTestId("appointment-check-in");
  await expect(checkIn).toBeEnabled();
  await expect(checkIn).toHaveClass(/primary/u);
  await expect(detail.locator("footer .primary")).toHaveCount(1);
  await checkIn.click();

  // CHECKED IN: Ready for Pickup appears, enabled, and IS THE PRIMARY. Take Payment does NOT
  // appear - a groomer holds no `checkout.perform` - and with no money action on the footer the
  // one enabled workflow control takes the dominant slot rather than standing beside an asleep
  // Save that used to hold it. Human QA read that footer as "no Ready for Pickup".
  const ready = detail.getByTestId("appointment-ready");
  await expect(ready).toBeEnabled();
  await expect(ready).toHaveClass(/^primary /u);
  await expect(detail.locator("footer .primary")).toHaveCount(1);
  await expect(ready).not.toHaveAttribute("title", /permission/u);
  await expect(detail.getByTestId("appointment-take-payment")).toHaveCount(0);

  await ready.click();

  // The server's answer, which is the only one that counts.
  await expect(async () => {
    const response = await request.get(`/api/appointments/${appointment.id}`);
    expect(((await response.json()) as { status: string }).status).toBe("completed");
  }).toPass();
  await expect(detail.getByTestId("appointment-ready")).toHaveCount(0);
});
