import { test, expect, login, createAppointment, createMember, password } from "./fixtures/tenant.js";
import type { Page } from "@playwright/test";
import { permissionPresets } from "@pawsh/domain";
import { expectCriticalTarget, expectEffectiveTarget, expectNoDocumentOverflow } from "./helpers/responsive.js";

/**
 * THE CALENDAR ON A PHONE.
 *
 * Human QA on an iPhone: the general mobile pass had improved things, but the calendar toolbar
 * was still a stack of full-size controls, and the calendar opened on a week grid that had to be
 * scrolled sideways to find today. Three product decisions are held here, in the device profiles
 * that can exercise them (the `@responsive` tag runs this under iPhone and Pixel as well as
 * desktop Chromium; the phone assertions skip themselves on a desktop viewport):
 *
 *   THE TOOLBAR FITS. No horizontal overflow, every control a 44px EFFECTIVE target, and fewer of
 *       them: the two that duplicated the header's + New are gone from the markup at every width.
 *       A second QA pass found three rows of 44px boxes still too spacious, so the controls now
 *       PAINT at 36px and reach 44px through an invisible hit area - which is why the toolbar is
 *       measured with `expectEffectiveTarget` (what `elementFromPoint` answers) rather than the
 *       bounding box, and why its height is held under 130px rather than 170.
 *   ONE DOOR INTO BOOKING. The header's + New menu; the toolbar's `+ Add booking` is not drawn.
 *   THE CALENDAR OPENS ON TODAY, IN THE DAY VIEW, on a phone. A desk looking ahead keeps the
 *       desktop week; a phone is opened to answer "what is happening now".
 *   A GROOMER'S PHONE OPENS ON THEIR OWN COLUMN, by employee id and never by name. This half is
 *       BACKEND-DEPENDENT: it reads `employeeId` off `GET /api/me`.
 */

const RECEPTIONIST = [...new Set([...permissionPresets.receptionist!, "appointments.edit_all_staff"])];
const GROOMER = [...new Set([...permissionPresets.groomer!, "appointments.edit", "calendar.blocks_create", "calendar.blocks_edit"])];

async function openNavigation(page: Page): Promise<void> {
  if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-calendar").isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
}

async function openCalendar(page: Page): Promise<void> {
  await openNavigation(page);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

/** Whether this project's viewport is a PHONE: the stylesheet's calendar breakpoint, not touch. */
function phoneWidth(testInfo: { project: { use: { viewport?: { width: number } | null } } }): boolean {
  return (testInfo.project.use.viewport?.width ?? 1280) <= 580;
}

/** Today, as the salon's own wall clock says it - the fixture business is in Los Angeles. */
function todayInSalon(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

test("@responsive the calendar toolbar fits a phone: no overflow, 44px targets, one booking door",
  async ({ page, request, tenant }, testInfo) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await expectNoDocumentOverflow(page, testInfo);

    // ONE CANONICAL NEW APPOINTMENT. The header's + New is the door and the critical target; the
    // toolbar draws neither a booking button nor a Block time button at any width.
    await expectCriticalTarget(page.getByTestId("new-action-trigger"));
    await expect(page.getByTestId("calendar-add-appointment")).toHaveCount(0);
    await expect(page.locator('.calendar-toolbar [data-action="blocked-time"]')).toHaveCount(0);
    await expect(page.locator('.calendar-toolbar [data-action="new-appointment"]')).toHaveCount(0);
    await page.getByTestId("new-action-trigger").click();
    const menu = page.getByTestId("new-action-menu");
    await expect(menu.getByRole("menuitem", { name: "New Appointment" })).toBeEnabled();
    await expect(menu.getByRole("menuitem", { name: "New Block Time" })).toBeEnabled();
    await page.keyboard.press("Escape");

    // Every remaining toolbar control is a full EFFECTIVE touch target in the phone layout, and
    // paints no taller than 36px. (A tablet keeps the desktop toolbar, whose period arrows are as
    // wide as an arrow and always were.)
    if (phoneWidth(testInfo)) {
      for (const selector of ["#calendar-today", "#calendar-prev-week", "#calendar-next-week", "#calendar-view-select",
        "#groomer-filter-trigger", "[data-testid=print-agenda]", "[data-testid=calendar-settings]",
        "#calendar-agenda-mode", "#calendar-calendar-mode"]) {
        await expectEffectiveTarget(page.locator(selector));
      }
      for (const selector of ["#calendar-today", "#calendar-prev-week", "#groomer-filter-trigger", "[data-testid=print-agenda]", "#calendar-agenda-mode"]) {
        const box = await page.locator(selector).boundingBox();
        expect(box!.height, `${selector} paints compact`).toBeLessThanOrEqual(38);
      }
      // And substantially fewer of them than the twelve QA counted: nine controls over three rows.
      const visible = await page.locator(".calendar-toolbar button, .calendar-toolbar select, .calendar-toolbar summary")
        .filter({ visible: true }).count();
      expect(visible).toBeLessThanOrEqual(9);
      const toolbar = await page.locator(".calendar-toolbar").boundingBox();
      expect(toolbar!.height, "three compact rows plus gaps").toBeLessThan(130);
    }
    await expectNoDocumentOverflow(page, testInfo);
  });

test("@responsive a receptionist's phone opens the calendar on today in the day view",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(!phoneWidth(testInfo), "the phone default is decided by the viewport, and this is not a phone's");
    const desk = await createMember(request, `desk+${tenant.runId}@pawsh-test.example`, RECEPTIONIST);
    // A visit next week, which is where the desktop's "first upcoming" landing would have gone.
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, desk.email, password);
    await openCalendar(page);

    await expect(page.locator("#calendar-view-select")).toHaveValue("day");
    await expect(page.locator("#calendar-calendar-mode")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#calendar-list")).toHaveClass(/day-grid/u);
    // Today, not the first booked day: the range label is one day, in the salon's MM/DD/YYYY, and
    // it is today's.
    const today = todayInSalon();
    await expect(page.locator("#calendar-range")).toHaveText(new RegExp(`${today.slice(5, 7)}/${today.slice(8, 10)}/${today.slice(0, 4)}$`, "u"));
    await expectNoDocumentOverflow(page, testInfo);

    // The operator's own choice afterwards is kept: switching to the week and coming back does
    // not snap to the phone default again.
    await page.locator("#calendar-view-select").selectOption("week");
    await page.waitForLoadState("networkidle");
    await openNavigation(page);
    await page.getByTestId("nav-customers").click();
    await expect(page.getByTestId("customers-view")).toBeVisible();
    await openCalendar(page);
    await expect(page.locator("#calendar-view-select")).toHaveValue("week");
  });

test("@responsive a groomer's phone opens on today in their own column, by employee id",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(!phoneWidth(testInfo), "the phone default is decided by the viewport, and this is not a phone's");
    // BACKEND-DEPENDENT: `GET /api/me` must carry `employeeId` for the linked membership.
    const second = await (await request.post("/api/employees", {
      data: { displayName: "Gabriel Groomer", serviceIds: [tenant.serviceId] }
    })).json() as { id: string };
    const grace = await createMember(request, `grace+${tenant.runId}@pawsh-test.example`, GROOMER);
    const linked = await request.put(`/api/employees/${tenant.employeeId}`, { data: { membershipId: grace.membershipId } });
    expect(linked.ok(), await linked.text()).toBeTruthy();
    await login(page, grace.email, password);
    await openCalendar(page);

    await expect(page.locator("#calendar-view-select")).toHaveValue("day");
    // Grace's column and only Grace's: the filter defaulted to her employee id.
    await expect(page.locator(".day-groomer", { hasText: "Grace Groomer" })).toBeVisible();
    await expect(page.locator(".day-groomer", { hasText: "Gabriel Groomer" })).toHaveCount(0);
    await expect(page.locator("#groomer-filter-trigger")).toContainText("1 groomer");
    await expectNoDocumentOverflow(page, testInfo);
    // The default was not written as a preference: nothing in storage claims she chose it.
    expect(await page.evaluate((businessId) => localStorage.getItem(`pawsh:groomer-filter:${businessId}`), tenant.businessId)).toBeNull();
    expect(second.id).toBeTruthy();
  });

test("the desktop calendar default is untouched: the week, positioned as before",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "the desktop default belongs to the desktop project");
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await expect(page.locator("#calendar-view-select")).toHaveValue("week");
    await expect(page.locator("#calendar-list")).toHaveClass(/week-grid/u);
  });
