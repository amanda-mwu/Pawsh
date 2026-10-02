import { expect, type Page } from "@playwright/test";

/** Today's date in the fixture salon's zone, as `YYYY-MM-DD`. */
function salonToday(timeZone = "America/Los_Angeles"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

/**
 * Answers the in-app "Check in early?" question that every Check In asks on a visit dated after
 * today. `localDate` is the visit's own date: after today the dialog must appear and is confirmed;
 * today or earlier it must not appear at all. The fixture's `anchor` is next Monday, so a visit
 * on it is always early.
 */
export async function answerEarlyCheckIn(page: Page, localDate: string): Promise<void> {
  const question = page.getByTestId("future-check-in-question");
  if (localDate.slice(0, 10) <= salonToday()) {
    await expect(question).toHaveCount(0);
    return;
  }
  await expect(question).toBeVisible();
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
}
