import { test, expect, login, createAppointment, createMember, completeAppointment } from "./fixtures/tenant.js";
import type { APIRequestContext, Page } from "@playwright/test";
import { permissionPresets } from "@pawsh/domain";
import { revealAppointmentOnCalendar } from "./helpers/calendar.js";

/**
 * QA ROUND 3 · THE CALENDAR AS A GROOMER AND THE DESK USE IT, IN A BROWSER.
 *
 * `tests/ui/qa-round3.test.ts` runs the handlers and the layout as written; this file asks what
 * only a rendered page answers: where a press lands, how wide a card is drawn, what the strip
 * reads at a lane's width, where a groomer's session opens, and a finger lifting her own lunch.
 */

const GROOMER = [...new Set([...permissionPresets.groomer!, "appointments.edit", "calendar.blocks_create", "calendar.blocks_edit"])];

async function openCalendar(page: Page): Promise<void> {
  if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-calendar").isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

async function cancel(api: APIRequestContext, visit: { id: string; version: number }): Promise<void> {
  const response = await api.post(`/api/appointments/${visit.id}/transition`, { data: { status: "cancelled", reason: "e2e", version: visit.version } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** A groomer member linked to the tenant's own employee, so the tenant's visits and blocks are hers. */
async function groomer(api: APIRequestContext, tenant: { runId: string; employeeId: string }) {
  const member = await createMember(api, `grace+${tenant.runId}@pawsh-test.example`, GROOMER);
  const linked = await api.put(`/api/employees/${tenant.employeeId}`, { data: { membershipId: member.membershipId } });
  expect(linked.ok(), await linked.text()).toBeTruthy();
  return member;
}

// ─── 1 · the whole card opens the visit ──────────────────────────────────────────────────────

test("a press on a card's strip opens the visit, a cancelled card's too; a drag still drags", async ({ page, request, tenant }, testInfo) => {
  const live = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  const gone = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T15:30` });
  await cancel(request, gone);
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  await page.locator("#calendar-view-select").selectOption("day");
  await revealAppointmentOnCalendar(page, live.id);
  const surface = page.getByTestId("appointment-detail-surface");
  for (const id of [live.id, gone.id]) {
    const card = page.locator(`#calendar-list [data-appointment-id="${id}"]`).filter({ visible: true }).first();
    await card.scrollIntoViewIfNeeded();
    // The time in the strip: no button lies under it.
    await card.locator(".appointment-time").click({ position: { x: 4, y: 4 } });
    await expect(surface).toBeVisible();
    await expect(page.getByTestId("appointment-reference")).toContainText(`#${id.slice(0, 8)}`);
    await page.keyboard.press("Escape");
    await expect(surface).toBeHidden();
  }
  test.skip(testInfo.project.name !== "chromium", "drag is a fine-pointer affordance");
  const card = page.locator(`#calendar-list [data-appointment-id="${live.id}"]`).filter({ visible: true }).first();
  // Opening the 15:30 card scrolled the grid down to it; the 9:00 card is brought back first.
  await card.scrollIntoViewIfNeeded();
  const box = (await card.locator(".appointment-head").boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 10, box.y + 70, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("stacked-dialog")).toBeVisible();
  await expect(surface).toBeHidden();
  await page.getByTestId("stacked-dialog-dismiss").click();
});

// ─── 2 · the strip is one readable line ──────────────────────────────────────────────────────

test("an overlap lane's strip is one line: the start whole, the chip whole, nothing cut mid-character", async ({ page, request, tenant }) => {
  const first = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T14:00` });
  const overlap = await request.post("/api/appointments", { headers: { "Idempotency-Key": crypto.randomUUID() }, data: {
    locationId: tenant.locationId, customerId: tenant.sophiaCustomerId, petId: tenant.mochiPetId, employeeId: tenant.employeeId,
    serviceIds: [tenant.serviceId], localStart: `${tenant.anchor}T14:30`, expectedLocationVersion: tenant.locationVersion,
    overrideConflict: true, overrideReason: "e2e: deliberate overlap"
  } });
  expect(overlap.ok(), await overlap.text()).toBeTruthy();
  const second = await overlap.json() as { id: string };
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  await page.locator("#calendar-view-select").selectOption("week");
  await revealAppointmentOnCalendar(page, first.id);
  for (const id of [first.id, second.id]) {
    const card = page.locator(`#calendar-list [data-appointment-id="${id}"]`).filter({ visible: true }).first();
    await expect(card).toHaveAttribute("data-card-lanes", "2");
    // Polled: a grid repaint that lands mid-read replaces the card, and a detached element measures
    // as all zeros - the chip read as "cut" when it was simply gone. Each poll re-resolves the card.
    const shape = () => card.evaluate((element) => {
      const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
      const head = rect(".appointment-head"), time = rect(".appointment-time"), from = rect(".time-from"), to = rect(".time-to");
      const chip = rect(".appointment-badge"), card = element.getBoundingClientRect();
      return {
        oneLine: head.height <= 24,
        fromWhole: from.right <= time.right + 0.5,
        // The end is either drawn whole on the line or dropped whole below it - never half of it.
        toWholeOrGone: to.width === 0 || to.top >= time.bottom - 1 || to.right <= time.right + 0.5,
        chipWhole: chip.width > 0 && chip.right <= card.right + 0.5,
        chipBesideTime: chip.top < time.bottom && chip.bottom > time.top
      };
    });
    await expect.poll(shape).toEqual({ oneLine: true, fromWhole: true, toWholeOrGone: true, chipWhole: true, chipBesideTime: true });
  }
});

// ─── 3 · a lone visit takes its lane ─────────────────────────────────────────────────────────

test("the only visit in a column is drawn the whole lane wide", async ({ page, request, tenant }) => {
  const lone = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T10:00` });
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  for (const view of ["day", "week"]) {
    await page.locator("#calendar-view-select").selectOption(view);
    await revealAppointmentOnCalendar(page, lone.id);
    const card = page.locator(`#calendar-list [data-appointment-id="${lone.id}"]`).filter({ visible: true }).first();
    await expect(card).not.toHaveAttribute("data-card-covers", "");
    const [cardWidth, laneWidth] = await card.evaluate((element) => {
      const slot = [...document.querySelectorAll<HTMLElement>("#calendar-list [data-slot]")]
        .find((each) => each.style.gridColumnStart === (element as HTMLElement).style.gridColumnStart)!;
      return [element.getBoundingClientRect().width, slot.getBoundingClientRect().width];
    });
    // Its own 3px margins either side, and no 16px reserve for a cancelled visit that is not there.
    expect(laneWidth - cardWidth).toBeLessThanOrEqual(8);
  }
});

// ─── 4 · ready for pickup reads at a glance ──────────────────────────────────────────────────

test("a completed, invoiced, unpaid visit reads Ready for pickup on its card, hover, dashboard row and head", async ({ page, request, tenant }, testInfo) => {
  const visit = await completeAppointment(request, tenant);
  const checkout = await request.post(`/api/appointments/${visit.id}/checkout`, {
    headers: { "Idempotency-Key": crypto.randomUUID() }, data: { discountMinor: 0, discountType: "manual", tipMinor: 0 }
  });
  expect(checkout.ok(), await checkout.text()).toBeTruthy();
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  await revealAppointmentOnCalendar(page, visit.id);
  const card = page.locator(`#calendar-list [data-appointment-id="${visit.id}"]`).filter({ visible: true }).first();
  await expect(card.locator(".appointment-badge")).toHaveCount(2);
  await expect(card.locator(".appointment-badge").nth(0)).toHaveAttribute("aria-label", "Ready for pickup");
  await expect(card.locator(".appointment-badge").nth(1)).toHaveAttribute("aria-label", "Unpaid");
  if (testInfo.project.name === "chromium") {
    await card.locator(".appointment-pet").hover();
    await expect(page.locator("#calendar-hover-preview .hover-status")).toContainText("RDY Ready for pickup · UNP Unpaid");
  }
  await card.locator(".appointment-time").click({ position: { x: 4, y: 4 } });
  await expect(page.getByTestId("appointment-status")).toHaveText("Ready for pickup");
  await page.keyboard.press("Escape");
  if (await page.locator("#mobile-nav-toggle").isVisible()) await page.locator("#mobile-nav-toggle").click();
  await page.getByTestId("nav-dashboard").click();
  const row = page.locator(`#today-list [data-appointment-id="${visit.id}"]`);
  // The dashboard lists today; the fixture's visit is on its anchor day, so only assert when shown.
  if (await row.count()) await expect(row.locator(".appointment-status-chips")).toHaveText(/Ready for pickup\s*UNP/u);
});

// ─── 5 · a groomer's session opens on its own today ──────────────────────────────────────────

test("a groomer signing in after the owner scrolled away opens with the scroll reset and the day revealed", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  const grace = await groomer(request, tenant);
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  await page.locator(".week-scroll").evaluate((scroll) => { scroll.scrollLeft = scroll.scrollWidth; scroll.scrollTop = scroll.scrollHeight; });
  await page.getByTestId("account-trigger").click();
  await page.getByTestId("logout").click();
  await login(page, grace.email);
  await expect(page.locator("body")).toHaveAttribute("data-view", "calendar");
  await expect(page.locator("#calendar-list")).not.toHaveAttribute("aria-busy", "true");
  const landed = await page.locator(".week-scroll").evaluate((scroll) => {
    const head = scroll.querySelector<HTMLElement>(".week-day-head.selected,.day-groomer");
    const box = scroll.getBoundingClientRect(), at = head?.getBoundingClientRect();
    return { top: scroll.scrollTop, selectedInView: Boolean(at && at.left >= box.left - 1 && at.left < box.right) };
  });
  expect(landed).toEqual({ top: 0, selectedInView: true });
});

// ─── 6 · a groomer moves her own lunch, on a phone too ───────────────────────────────────────

test("a groomer lifts her own block with a held finger and drops it; a quick swipe only scrolls", async ({ browser, request, tenant }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "touch is dispatched through the Chromium protocol");
  const grace = await groomer(request, tenant);
  const block = await request.post("/api/blocked-times", { data: {
    employeeId: tenant.employeeId, locationId: tenant.locationId, localStart: `${tenant.anchor}T12:00`,
    localEnd: `${tenant.anchor}T12:30`, reason: "Lunch", expectedLocationVersion: tenant.locationVersion
  } });
  expect(block.ok(), await block.text()).toBeTruthy();
  const lunch = await block.json() as { id: string };
  const anchorVisit = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, baseURL: testInfo.project.use.baseURL ?? "http://127.0.0.1:3000" });
  const page = await context.newPage();
  try {
    await login(page, grace.email);
    await openCalendar(page);
    // The phone opens on today in the day view; the fixture's day is its anchor, up to a week
    // away. The visit booked on that day is what the helper pages to, and the band is beside it.
    await revealAppointmentOnCalendar(page, anchorVisit.id);
    const band = page.locator(`[data-blocked-time-id="${lunch.id}"]`).filter({ visible: true }).first();
    await band.scrollIntoViewIfNeeded();
    await expect(band).toHaveAttribute("data-draggable", "true");
    const box = (await band.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", px = x, py = y) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: px, y: py, id: 1 }] });

    // A swipe that never held still scrolls the grid and carries nothing.
    await touch("touchStart");
    for (let move = 1; move <= 8; move += 1) await touch("touchMove", x, y - move * 10);
    await touch("touchEnd");
    await expect(page.locator(".calendar-block.dragging")).toHaveCount(0);
    await expect(page.getByTestId("stacked-dialog")).toBeHidden();

    // Held, then carried an hour down: the same ask-then-PATCH a mouse drop gets. The swipe's
    // scroll can still be settling (Linux CI), so the band is measured only once it has stopped
    // moving - a hold taken mid-scroll lands beside it.
    let last = "";
    await expect.poll(async () => {
      const now = JSON.stringify(await band.boundingBox());
      const settled = now === last;
      last = now;
      return settled;
    }, { intervals: [150] }).toBe(true);
    const held = (await band.boundingBox())!;
    const hx = held.x + held.width / 2, hy = held.y + held.height / 2;
    await touch("touchStart", hx, hy);
    await page.waitForTimeout(500);
    for (let move = 1; move <= 12; move += 1) await touch("touchMove", hx, hy + move * 6);
    await expect(page.locator(".calendar-block.dragging")).toHaveCount(1);
    await touch("touchEnd", hx, hy + 72);
    await expect(page.getByTestId("stacked-dialog")).toBeVisible();
    await expect(page.getByTestId("blocked-time-move-question")).toContainText("Move this block time to");
    await page.getByTestId("stacked-dialog-dismiss").click();
  } finally {
    await context.close();
  }
});
