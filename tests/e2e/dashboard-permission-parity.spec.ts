import { test, expect, login, createMember, password } from "./fixtures/tenant.js";
import type { Page } from "@playwright/test";

/**
 * A VISIBLE DESTINATION HAS TO BE A LOADABLE ONE.
 *
 * Migration 0043 split `dashboard.view` off `reports.view` deliberately, so a receptionist can see
 * the day's takings without being handed the reports. `GET /api/dashboard` was moved onto the new
 * permission; the client's prefetch was not, and went on asking `reports.view`. The result for
 * exactly the role the split existed to create was a Dashboard button — gated correctly on
 * `dashboard.view` — over a screen the client had declined to fetch.
 *
 * The fix aligns the frontend with the backend's authority. It does NOT widen the permission to
 * hide the mismatch: `canViewDashboard()` is now the single predicate behind both the nav button
 * and the prefetch, so the two cannot disagree again.
 *
 * The request is what these assert, rather than the rendered figures. `renderDashboard({})` draws
 * the same four tiles as a real payload, with zeroes — which is precisely why the defect was
 * invisible on screen and has to be pinned at the network.
 */

/** Records every `GET /api/dashboard` the page makes, with the status it came back with. */
function watchDashboardReads(page: Page): Array<Promise<number>> {
  const reads: Array<Promise<number>> = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/dashboard") {
      reads.push(Promise.resolve(response.status()));
    }
  });
  return reads;
}

test("a role with dashboard.view and no reports.view gets a Dashboard that loads", async ({
  page,
  request,
  tenant
}) => {
  const member = await createMember(request, `dashboard-only+${tenant.runId}@pawsh-test.example`, [
    "dashboard.view", "dashboard.summary", "dashboard.revenue", "calendar.view", "appointments.view"
  ]);
  const reads = watchDashboardReads(page);
  await login(page, member.email, password);

  // The receptionist the split exists for: takings yes, reports no.
  await expect(page.getByTestId("nav-dashboard")).toBeVisible();
  await expect(page.getByTestId("nav-reports")).toBeHidden();

  // THE ASSERTION. The prefetch happened and the server allowed it. Before the alignment this
  // array was empty, and the button above opened four zeroes.
  expect(reads.length).toBeGreaterThan(0);
  expect(await Promise.all(reads)).toEqual(reads.map(() => 200));

  await page.getByTestId("nav-dashboard").click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.locator("#metrics .metric")).toHaveCount(4);
});

test("a role with reports.view and no dashboard.view is not offered a Dashboard at all", async ({
  page,
  request,
  tenant
}) => {
  const member = await createMember(request, `reports-only+${tenant.runId}@pawsh-test.example`, [
    "reports.view", "calendar.view", "appointments.view"
  ]);
  const reads = watchDashboardReads(page);
  await login(page, member.email, password);

  await expect(page.getByTestId("nav-dashboard")).toBeHidden();
  await expect(page.getByTestId("nav-reports")).toBeVisible();

  // The inverse, and it is not merely cosmetic: the old prefetch asked for the dashboard on this
  // role's behalf and was refused, so every sign-in spent a 403 on a screen the member could not
  // open. Nothing asks for it now.
  expect(await Promise.all(reads)).toEqual([]);

  // The nav button is hidden, and `activateView` refuses a view whose button is hidden, so this
  // session lands somewhere it actually has rather than on a blank shell.
  await expect(page.getByTestId("dashboard")).toBeHidden();
  await expect(page.locator("#app-view")).toBeVisible();
});
