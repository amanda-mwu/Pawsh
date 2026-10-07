import { test, expect, login, createAppointment } from "./fixtures/tenant.js";
import type { Page } from "@playwright/test";
import { revealAppointmentOnCalendar } from "./helpers/calendar.js";

/**
 * THE QA PASS'S CALENDAR ROWS, IN A BROWSER.
 *
 * The source-level half is `tests/ui/qa-pass-calendar.test.ts`; this file asks what only a
 * rendered page can answer - a card's strip at a lane's width, a menu's rows, the read-failure
 * banner, the phone toolbar's rows and the landscape shell.
 */

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

test("a week slot draws only its two grid rules", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  await page.locator("#calendar-view-select").selectOption("week");
  const borders = await page.locator(".week-slot").first().evaluate((slot) => {
    const style = getComputedStyle(slot);
    return [style.borderRightWidth, style.borderBottomWidth, style.borderTopWidth];
  });
  // No button border right or below; the top grid rule stays. (The left rule is 1px, or the firmer
  // 2px day boundary on a day's first lane - with one groomer, every lane is a day's first.)
  expect(borders).toEqual(["0px", "0px", "1px"]);
});

test("a checked-in card offers Checkout in compact menu rows, and the preview stays away", async ({ page, request, tenant }) => {
  const visit = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T10:00` });
  await request.post(`/api/appointments/${visit.id}/transition`, { data: { status: "checked_in", version: visit.version } });
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  await revealAppointmentOnCalendar(page, visit.id);
  const card = page.locator(`#calendar-list [data-appointment-id="${visit.id}"]`);
  await card.hover();
  await card.locator(".calendar-action-trigger").click();
  const menu = page.locator(".calendar-action-popover:not([hidden])");
  await expect(menu.getByTestId("appointment-checkout")).toBeVisible();
  for (const row of await menu.getByRole("menuitem").all()) {
    const box = await row.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(32);
  }
  await expect(page.locator("#calendar-hover-preview")).toBeHidden();
});

// QA-CAL-08 · the card face reads like the book: strip (time, icon, code chip), pet, breed,
// services - wrapped in a narrow lane, never ellipsized, and no client name on the face.
test("an overlap lane's card keeps its code chip and wraps its pet instead of truncating it", async ({ page, request, tenant }) => {
  const live = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T12:30` });
  const overlap = await request.post("/api/appointments", { headers: { "Idempotency-Key": crypto.randomUUID() }, data: {
    locationId: tenant.locationId, customerId: tenant.customerId, petId: tenant.petId, employeeId: tenant.employeeId,
    serviceIds: [tenant.serviceId], localStart: `${tenant.anchor}T13:00`, expectedLocationVersion: tenant.locationVersion,
    overrideConflict: true, overrideReason: "e2e: deliberate overlap"
  } });
  const second = await overlap.json() as { id: string };
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  await page.locator("#calendar-view-select").selectOption("day");
  await revealAppointmentOnCalendar(page, live.id);
  for (const id of [live.id, second.id]) {
    const card = page.locator(`#calendar-list [data-appointment-id="${id}"]`).filter({ visible: true }).first();
    await expect(card).toHaveAttribute("data-card-lanes", "2");
    const chip = card.locator(".appointment-badge .badge-code");
    await expect(chip).toBeVisible();
    const [cardBox, chipBox] = [await card.boundingBox(), await chip.boundingBox()];
    expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    const pet = card.locator(".appointment-pet");
    await expect(pet).toHaveCSS("white-space", "normal");
    await expect(pet).toHaveCSS("text-overflow", "clip");
    await expect(card.locator(".appointment-breed")).toBeVisible();
    await expect(card.locator(".calendar-open")).not.toContainText("Emma Johnson");
    await expect(card.locator(".calendar-open")).toHaveAttribute("aria-label", /Emma Johnson/u);
  }
});

test("a cancelled visit does not halve the live one it crosses", async ({ page, request, tenant }) => {
  const live = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T12:30` });
  const overlap = await request.post("/api/appointments", { headers: { "Idempotency-Key": crypto.randomUUID() }, data: {
    locationId: tenant.locationId, customerId: tenant.customerId, petId: tenant.petId, employeeId: tenant.employeeId,
    serviceIds: [tenant.serviceId], localStart: `${tenant.anchor}T13:00`, expectedLocationVersion: tenant.locationVersion,
    overrideConflict: true, overrideReason: "e2e: deliberate overlap"
  } });
  const cancelled = await overlap.json() as { id: string; version: number };
  await request.post(`/api/appointments/${cancelled.id}/transition`, { data: { status: "cancelled", reason: "e2e", version: cancelled.version } });
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  await revealAppointmentOnCalendar(page, live.id);
  await expect(page.locator(`#calendar-list [data-appointment-id="${live.id}"]`)).not.toHaveAttribute("data-card-lanes", /.*/u);
  await expect(page.locator(`#calendar-list [data-appointment-id="${cancelled.id}"]`)).toHaveAttribute("data-card-behind", "");
});

test("a period that does not load says so above the grid, and Retry loads it", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  // A rate limit whose window is longer than the client will sit through, so it is not retried; a
  // 429 rather than a 5xx, because the fixture treats any 5xx the page sees as a server fault.
  let refuse = true;
  await page.route("**/api/appointments?**", (route) => (refuse
    ? route.fulfill({ status: 429, headers: { "retry-after": "60" }, contentType: "application/json", body: JSON.stringify({ error: "Rate limit exceeded" }) })
    : route.continue()));
  await page.locator("#calendar-next-week").click();
  await expect(page.locator("#calendar-read-error")).toBeVisible();
  refuse = false;
  await page.getByTestId("calendar-read-retry").click();
  await expect(page.locator("#calendar-read-error")).toHaveCount(0);
});

test("@responsive the phone toolbar is two rows and the dashboard tiles are two by two", async ({ page, tenant }, testInfo) => {
  test.skip((testInfo.project.use.viewport?.width ?? 1280) > 580, "a phone-width layout");
  await login(page, tenant.ownerEmail);
  const tiles = await page.locator(".metric-grid .metric").evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(new Set(tiles).size).toBe(2);
  await openCalendar(page);
  const toolbar = await page.locator(".calendar-toolbar").boundingBox();
  expect(toolbar!.height).toBeLessThan(95);
});

test("@responsive a phone on its side keeps the phone shell", async ({ page, tenant }, testInfo) => {
  test.skip((testInfo.project.use.viewport?.width ?? 1280) > 580, "a phone, turned");
  await page.setViewportSize({ width: 844, height: 390 });
  await login(page, tenant.ownerEmail);
  await expect(page.locator("#mobile-nav-toggle")).toBeVisible();
  await expect(page.getByTestId("nav-calendar")).toBeHidden();
  await openCalendar(page);
  const grid = await page.locator(".week-scroll").boundingBox();
  expect(grid!.y).toBeLessThan(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844);
});
