import { test, expect, login, createAppointment } from "./fixtures/tenant.js";
import type { APIRequestContext, Page } from "@playwright/test";
import { prefLocalDate } from "./helpers/calendar.js";

/**
 * A BLOCK MOVES THE WAY A CARD MOVES: DRAG, ASK, THEN PATCH.
 *
 * The band was deliberately not draggable while a block could only be read. It can be edited now,
 * and "shift my lunch half an hour" through the drawer's four fields was the long way round. So a
 * band this session may move carries the same `data-draggable` a card does, and a drop goes
 * through the same confirm-before-request gate: the question names the destination, Cancel and
 * Escape issue no request at all, and OK is one PATCH with the block's own version and an end
 * derived from its length.
 *
 * `tests/ui/blocked-time-calendar.test.ts` holds the band's anatomy; this walk holds the gesture,
 * the dialog and the wire, which only a browser can.
 */

async function createBlock(
  request: APIRequestContext, tenant: { employeeId: string; locationId: string; locationVersion: number },
  options: { localStart: string; localEnd: string; reason: string }
): Promise<{ id: string; version: number }> {
  const response = await request.post("/api/blocked-times", { data: {
    employeeId: tenant.employeeId, locationId: tenant.locationId, localStart: options.localStart,
    localEnd: options.localEnd, reason: options.reason, expectedLocationVersion: tenant.locationVersion
  } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { id: string; version: number };
}

async function openCalendar(page: Page): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

/** The card helper's gesture, for a band: pointer down on the label, past the threshold, to the slot. */
async function dragBlockToSlot(page: Page, { blockId, slot, groomerId }: { blockId: string; slot: string; groomerId: string }): Promise<void> {
  const target = page.locator(`[data-slot="${slot}"][data-slot-groomer="${groomerId}"]`).first();
  await target.scrollIntoViewIfNeeded();
  const grip = page.locator(`[data-blocked-time-id="${blockId}"] .calendar-block-label`).first();
  const from = await grip.boundingBox();
  const to = await target.boundingBox();
  expect(from, "the band being dragged has to be on screen").not.toBeNull();
  expect(to, "the slot being dropped on has to be on screen").not.toBeNull();
  const startX = from!.x + from!.width / 2, startY = from!.y + from!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 24);
  // Just inside the row's top: where the pointer lets go inside a 30-minute row is snapped to the
  // nearest five minutes, and the row's own time is the one these tests are about.
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height * 0.05, { steps: 8 });
  await page.mouse.up();
}

test("dragging a block asks first, sends nothing on Cancel, and one PATCH on OK",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "drag is a fine-pointer affordance");
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const lunch = await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);

    const band = page.locator(`[data-blocked-time-id="${lunch.id}"]`).first();
    await expect(band).toHaveAttribute("data-draggable", "true");
    await expect(band).toContainText("12:00 PM–12:30 PM");

    const patches: Array<Record<string, unknown>> = [];
    await page.route(`**/api/blocked-times/${lunch.id}`, async (route) => {
      if (route.request().method() === "PATCH") patches.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.continue();
    });
    const confirm = page.getByTestId("stacked-dialog");

    // CANCEL: the question, and nothing on the wire.
    await dragBlockToSlot(page, { blockId: lunch.id, slot: `${tenant.anchor}T13:00`, groomerId: tenant.employeeId });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("heading", { name: "Move block time" })).toBeVisible();
    await expect(page.getByTestId("blocked-time-move-question"))
      .toHaveText(`Move this block time to ${prefLocalDate(tenant.anchor)} 1:00 PM?`);
    expect(patches).toEqual([]);
    await confirm.getByTestId("stacked-dialog-dismiss").click();
    await expect(confirm).toBeHidden();
    expect(patches).toEqual([]);
    await expect(band).toContainText("12:00 PM–12:30 PM");

    // OK: one PATCH carrying the version, the same staff member, the new start and an end the
    // block's own length later - then the band is where it was dropped.
    await dragBlockToSlot(page, { blockId: lunch.id, slot: `${tenant.anchor}T13:00`, groomerId: tenant.employeeId });
    await expect(confirm).toBeVisible();
    await confirm.getByTestId("stacked-dialog-confirm").click();
    await expect(async () => { expect(patches).toHaveLength(1); }).toPass();
    expect(patches[0]).toMatchObject({
      version: lunch.version, employeeId: tenant.employeeId,
      localStart: `${tenant.anchor}T13:00`, localEnd: `${tenant.anchor}T13:30`
    });
    await expect(page.locator(`[data-blocked-time-id="${lunch.id}"]`).first()).toContainText("1:00 PM–1:30 PM");
    await expect(page.locator("#toast")).toContainText("Block time moved");
    const stored = await (await request.get(`/api/blocked-times?localDate=${tenant.anchor}&days=1`)).json() as Array<{ id: string; scheduledLocalStart: string; scheduledLocalEnd: string }>;
    const moved = stored.find((block) => block.id === lunch.id)!;
    expect(moved.scheduledLocalStart).toBe(`${tenant.anchor}T13:00`);
    expect(moved.scheduledLocalEnd).toBe(`${tenant.anchor}T13:30`);
  });

test("a block that runs across days is not draggable, because a drop names one day's start",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "drag is a fine-pointer affordance");
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const long = await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T15:00`, localEnd: `${tenant.anchor.slice(0, 8)}${String(Number(tenant.anchor.slice(8, 10)) + 2).padStart(2, "0")}T10:00`,
      reason: "Away"
    });
    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    const band = page.locator(`[data-blocked-time-id="${long.id}"]`).first();
    await expect(band).toBeVisible();
    await expect(band).not.toHaveAttribute("data-draggable", "true");
  });
