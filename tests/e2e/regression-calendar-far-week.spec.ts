import { test, expect, login, createAppointment } from "./fixtures/tenant.js";
import { dragAppointmentToSlot } from "./helpers/calendar.js";
import type { Page } from "@playwright/test";

/**
 * A CALENDAR SHOWING A WEEK A MONTH OUT MUST STILL BE SHOWING IT AFTER A REFRESH.
 *
 * `refresh()` reloaded a fixed eight-day window anchored on TODAY and then overwrote
 * `state.appointments` wholesale, so any of its thirty-odd callers emptied the grid for an operator
 * working outside those eight days. The grid stayed drawn, every card left it, and pressing Today
 * appeared to repair it only because Today navigates back into the window that had been loaded.
 *
 * The two triggers here are the two the salon owner actually hit: a drag that SUCCEEDED, and
 * switching to another browser tab and back — `visibilitychange`, which runs the same `refresh()`.
 * Neither of them is a failure path, which is what made this so disorienting: everything the
 * operator did worked, and the schedule vanished anyway.
 *
 * `tests/ui/calendar-refresh-window.test.ts` holds the window arithmetic, every view mode and the
 * in-flight-navigation race. What needs a browser is the whole loop — a real week on screen, a real
 * refresh, a real repaint — so that is what this is.
 */

/** The Monday four weeks past the fixture's anchor: far outside any window based on today. */
function farWeek(anchor: string): string {
  const monday = new Date(`${anchor}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() + 28);
  return monday.toISOString().slice(0, 10);
}

/** The Sunday the grid starts that week on, which is the `localDate` the two reads carry. */
function gridWeekStart(date: string): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - day.getUTCDay());
  return day.toISOString().slice(0, 10);
}

/**
 * Pages the week grid forward until the card is on it, the way an operator would.
 *
 * The step is waited on by the RANGE LABEL changing, not by `networkidle`: the click hands the
 * navigation to `runDetached`, so the page is momentarily idle again before the read has even been
 * issued and a network wait returns while nothing has moved. `#calendar-range` is written by the
 * same paint that draws the cards, so waiting for it to change waits for exactly one step.
 */
async function pageForwardTo(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  for (let step = 0; step < 10; step += 1) {
    if (await page.locator(`[data-appointment-id="${appointmentId}"]`).count() > 0) return;
    const range = await page.locator("#calendar-range").textContent();
    await page.locator("#calendar-next-week").click();
    await expect(page.locator("#calendar-range")).not.toHaveText(range ?? "");
    await page.waitForLoadState("networkidle");
  }
  throw new Error("the far week never came into view");
}

test("a far week keeps its cards when the operator switches tabs and back", async ({
  page,
  request,
  tenant
}) => {
  const far = farWeek(tenant.anchor);
  const appointment = await createAppointment(request, tenant, { localStart: `${far}T09:00` });
  await login(page, tenant.ownerEmail);
  await pageForwardTo(page, appointment.id);

  const card = page.locator(`[data-appointment-id="${appointment.id}"]`).first();
  await expect(card).toBeVisible();

  // Every `/api/appointments` read from here on, so the window that went out is evidence rather
  // than inference.
  const windows: string[] = [];
  page.on("request", (event) => {
    const url = new URL(event.url());
    if (url.pathname === "/api/appointments") windows.push(url.search);
  });

  // Returning to the tab. `document.visibilitychange` re-reads `/api/me` and calls `refresh()`,
  // which is the exact path that used to blank a far week for doing nothing at all.
  const reload = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/appointments"
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await reload;
  await page.waitForLoadState("networkidle");

  // THE ASSERTION. Before the fix this locator resolved to nothing while the grid stayed drawn.
  await expect(card).toBeVisible();
  // And the window that went out is the week on screen rather than the eight days after today —
  // the cause, not just the symptom.
  expect(windows).toContain(`?localDate=${gridWeekStart(far)}&days=7`);
  expect(windows.some((search) => search.includes("days=8"))).toBe(false);
});

test("a drag that succeeds on a far week leaves the week it moved within on screen", async ({
  page,
  request,
  tenant
}) => {
  const far = farWeek(tenant.anchor);
  const appointment = await createAppointment(request, tenant, { localStart: `${far}T09:00` });
  await login(page, tenant.ownerEmail);
  await pageForwardTo(page, appointment.id);

  const card = page.locator(`.week-appointment[data-appointment-id="${appointment.id}"]`);
  await expect(card.locator("time")).toContainText("9:00");

  // The gesture the salon owner reported: a drop within the week on screen, confirmed, which
  // succeeds — and then took every card off the grid, including the one just moved.
  await dragAppointmentToSlot(page, {
    appointmentId: appointment.id, slot: `${far}T11:00`, groomerId: tenant.employeeId
  });
  const confirm = page.getByTestId("stacked-dialog");
  await expect(confirm).toBeVisible();
  await confirm.getByTestId("stacked-dialog-confirm").click();
  await expect(confirm).toBeHidden();
  await expect(page.locator("#toast")).toContainText("moved to");
  await page.waitForLoadState("networkidle");

  // THE ASSERTION. The card is where it was dropped, on the week it was dropped on, and the grid
  // it is drawn in still has the week's range in its header.
  await expect(page.locator(`.week-appointment[data-appointment-id="${appointment.id}"] time`))
    .toContainText("11:00");
  await expect(page.locator("#calendar-range")).not.toHaveText("");
});
