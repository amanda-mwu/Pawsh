import { expect, type Page } from "@playwright/test";

/**
 * Helpers for the calendar's drag-to-move.
 *
 * The grid does NOT use HTML5 drag-and-drop, so `locator.dragTo()` would drive a mechanism the
 * client never listens to and pass while nothing moved. The real thing is a pointer stream with a
 * movement threshold, so the drag has to be spelled out: press on the card, travel far enough to
 * cross `CALENDAR_DRAG_THRESHOLD`, then land on the slot. A press that never travels is
 * deliberately still a click, and that is exactly the distinction a `dragTo()` shortcut erases.
 */

/**
 * Arms a wait for the calendar redraw that CLOSING A SURFACE leaves behind.
 *
 * Closing Check Out - or an appointment detail - schedules `refresh()` DETACHED: fourteen reads
 * followed by `renderAppointments()`, which replaces the whole grid. A spec that drives the
 * calendar again before that lands opens an action menu into a subtree that is about to be thrown
 * away. Measured on exactly that sequence, the menu opened 53ms after the close and the grid was
 * rebuilt out from under it 15ms later; the menu is then hidden for good, so Playwright reports an
 * element that resolved, went unstable and then detached, and retries until the test times out.
 *
 * `waitForLoadState("networkidle")` DOES NOT COVER THIS - measured on the same sequence it
 * returned 22ms after the close with all fourteen reads still in flight - which is why arming this
 * before the close is the thing that makes a reopen safe.
 *
 * The signal is the redraw itself rather than a duration: the card that was on screen before the
 * close is a different element afterwards, so waiting for the old node to leave the document waits
 * for exactly the rebuild and nothing more.
 */
export async function calendarRedraw(page: Page, appointmentId: string): Promise<() => Promise<void>> {
  const card = await page.locator(`[data-appointment-id="${appointmentId}"]`).first().elementHandle();
  expect(card, "the card has to be on screen before the redraw it is waiting on").not.toBeNull();
  return async () => {
    await page.waitForFunction((node) => !node.isConnected, card!);
  };
}

/** Reorder a `YYYY-MM-DD` the way `Settings -> Business -> Date format` does. */
export function prefLocalDate(localDate: string, format: "MM/DD/YYYY" | "DD/MM/YYYY" = "MM/DD/YYYY"): string {
  const [year, month, day] = localDate.slice(0, 10).split("-");
  return format === "DD/MM/YYYY" ? `${day}/${month}/${year}` : `${month}/${day}/${year}`;
}

/**
 * Drag an appointment card onto a slot and release, in whichever of the two grids is on screen.
 *
 * The slot is scrolled to first and the card is measured afterwards, because scrolling the grid
 * moves the card too - measuring in the other order aims the press at where the card used to be.
 * The grip is `.appointment-pet`: the overflow menu and the notes button are excluded from dragging
 * on purpose, so pressing at the card's centre is not a reliable way to start one.
 */
export async function dragAppointmentToSlot(
  page: Page,
  { appointmentId, slot, groomerId }: { appointmentId: string; slot: string; groomerId: string }
): Promise<void> {
  const target = page.locator(`[data-slot="${slot}"][data-slot-groomer="${groomerId}"]`).first();
  await target.scrollIntoViewIfNeeded();
  const grip = page.locator(`[data-appointment-id="${appointmentId}"] .appointment-pet`).first();
  const from = await grip.boundingBox();
  const to = await target.boundingBox();
  expect(from, "the card being dragged has to be on screen").not.toBeNull();
  expect(to, "the slot being dropped on has to be on screen").not.toBeNull();
  const startX = from!.x + from!.width / 2;
  const startY = from!.y + from!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // One step past the threshold, so the drag is genuinely begun before the travel to the target.
  await page.mouse.move(startX, startY + 24);
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
  await page.mouse.up();
}

/**
 * BRING THE CALENDAR TO THE FIXTURE'S APPOINTMENT ON A PHONE.
 *
 * A phone opens the calendar on TODAY in the day view - that is the product decision - while the
 * fixtures book on next Monday. A desk opens on the week and lands on the first booked day, so
 * the card is simply there; on a phone it is a day or a week away. This is the phone's way to it:
 * switch to the week, and page forward until the card is drawn. On a desk, where the card is
 * already on screen, it does nothing.
 */
export async function revealAppointmentOnCalendar(page: Page, appointmentId: string): Promise<void> {
  const card = page.locator(`[data-appointment-id="${appointmentId}"]`).first();
  // Polled rather than read once: `networkidle` returns before the grid's own reads settle (see
  // `calendarRedraw` above), and a card that is about to be painted must not be paged past.
  const drawn = async (): Promise<boolean> => {
    try { await expect.poll(() => card.count(), { timeout: 2_500 }).toBeGreaterThan(0); return true; }
    catch { return false; }
  };
  if (await drawn()) return;
  const view = page.locator("#calendar-view-select");
  if (await view.inputValue() === "day") {
    await view.selectOption("week");
    if (await drawn()) return;
  }
  for (let step = 0; step < 6; step += 1) {
    await page.locator("#calendar-next-week").click();
    if (await drawn()) return;
  }
  await expect(card).toBeAttached();
}
