import { test, expect, login, createAppointment, createMember, password } from "./fixtures/tenant.js";
import type { Page } from "@playwright/test";
import { permissionPresets } from "@pawsh/domain";

/**
 * WHAT THE DESK DID REACHES THE GROOMER'S OPEN CALENDAR WITHOUT HER PRESSING ANYTHING.
 *
 * Human QA cancelled a visit as the owner and Grace's calendar, open on another machine, kept
 * drawing it as scheduled until she navigated away and back. The calendar reads its period on
 * three doors now - the tab coming back, the window regaining focus, and a timer while it is on
 * screen - and this walk drives each one in a real browser against a real second actor.
 *
 * The timer is exercised through Playwright's clock rather than by waiting a minute, and the
 * scheduler is asserted from what the GRID shows, not from a request count.
 */

const GROOMER = [...permissionPresets.groomer!];

async function cancel(request: Parameters<typeof createAppointment>[0], appointment: { id: string; version: number }): Promise<void> {
  const response = await request.post(`/api/appointments/${appointment.id}/transition`, {
    data: { status: "cancelled", version: appointment.version }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

function card(page: Page, id: string) {
  return page.locator(`.week-appointment[data-appointment-id="${id}"]`).first();
}

test("the window regaining focus reads the calendar's period, and the cancellation is on the grid",
  async ({ page, request, tenant }) => {
    const graces = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const grace = await createMember(request, `grace+${tenant.runId}@pawsh-test.example`, GROOMER);
    await login(page, grace.email, password);
    await page.getByTestId("nav-calendar").click();
    await expect(card(page, graces.id)).toHaveClass(/status-scheduled/u);

    // THE DESK cancels it - the owner's own session, another machine.
    await cancel(request, graces);
    // Grace has done nothing; the grid still says scheduled, which is the finding.
    await expect(card(page, graces.id)).toHaveClass(/status-scheduled/u);

    // She clicks back into the window from wherever she was. One period read, and the grid is
    // right - the session and the rest of the workspace were not re-read for it.
    const reads: string[] = [];
    page.on("request", (sent) => { if (sent.url().includes("/api/")) reads.push(new URL(sent.url()).pathname); });
    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await expect(card(page, graces.id)).toHaveClass(/status-cancelled/u);
    expect(reads.filter((path) => path === "/api/appointments").length).toBeGreaterThanOrEqual(1);
    expect(reads).not.toContain("/api/me");
    expect(reads).not.toContain("/api/customers");
  });

test("the tab coming back still re-reads the session and the workspace, as it always did",
  async ({ page, request, tenant }) => {
    const graces = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    await page.getByTestId("nav-calendar").click();
    await expect(card(page, graces.id)).toHaveClass(/status-scheduled/u);
    await cancel(request, graces);

    const reads: string[] = [];
    page.on("request", (sent) => { if (sent.url().includes("/api/")) reads.push(new URL(sent.url()).pathname); });
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(card(page, graces.id)).toHaveClass(/status-cancelled/u);
    expect(reads).toContain("/api/me");
  });

test("while the calendar is on screen a timer reads the period once a minute",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "the installed clock is exercised once, on the desktop");
    const graces = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    // The clock is installed before the page loads so the scheduler's interval is the fake one;
    // it keeps running in real time until it is told to jump.
    await page.clock.install();
    await login(page, tenant.ownerEmail);
    await page.getByTestId("nav-calendar").click();
    await expect(card(page, graces.id)).toHaveClass(/status-scheduled/u);
    await cancel(request, graces);

    const reads: string[] = [];
    page.on("request", (sent) => { if (sent.url().includes("/api/")) reads.push(new URL(sent.url()).pathname); });
    // Fifty-nine seconds: nothing yet. The minute: the read goes out and the grid is right.
    await page.clock.runFor(59_000);
    expect(reads.filter((path) => path === "/api/appointments")).toHaveLength(0);
    await page.clock.runFor(1_000);
    await expect(card(page, graces.id)).toHaveClass(/status-cancelled/u);
    expect(reads.filter((path) => path === "/api/appointments")).toHaveLength(1);

    // ON ANOTHER VIEW the timer stands down: a minute on the clients list reads no period.
    await page.getByTestId("nav-customers").click();
    reads.length = 0;
    await page.clock.runFor(60_000);
    expect(reads.filter((path) => path === "/api/appointments")).toHaveLength(0);
  });
