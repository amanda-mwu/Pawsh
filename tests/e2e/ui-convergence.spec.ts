import { test, expect, login, createAppointment, createMember, prepareReceipt, password } from "./fixtures/tenant.js";
import type { Locator, Page } from "@playwright/test";
import { permissionPresets } from "@pawsh/domain";
import { checkoutSurface, openCheckout } from "./helpers/checkout.js";
import { invoiceSurface } from "./helpers/invoice.js";
import { dragAppointmentToSlot, revealAppointmentOnCalendar } from "./helpers/calendar.js";

/**
 * THE P1 ROWS OF THE UI CONVERGENCE AUDIT, AS A BROWSER SEES THEM.
 *
 * Each test here is one row of the ledger reproduced against the real page and then held: the
 * calendar's scroll box against the viewport, a card menu's rows under the pointer, the week a
 * phone opens on, what a cancelled visit looks like, the dashboard's list after the calendar has
 * been paged, a navigation item a role cannot use, a rate limit mid-session, and the three
 * footers a phone could not fit. `tests/ui/ui-convergence.test.ts` holds the same fixes at the
 * source; this file is what a viewport has to be asked.
 *
 * The second batch follows below the first: a dashboard row acted on after the calendar has paged
 * away, the care notes' colours, the dialog footer on a phone, the rail's leading pet, and the
 * card a drop lands on.
 */

const GROOMER = [...new Set([...permissionPresets.groomer!, "appointments.edit"])].filter((key) => key !== "customers.view");

async function openNavigation(page: Page): Promise<void> {
  if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-calendar").isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
}

async function openView(page: Page, view: "calendar" | "dashboard"): Promise<void> {
  await openNavigation(page);
  await page.getByTestId(`nav-${view}`).click();
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

/** The calendar's scroll box, measured against the viewport. */
async function scrollBox(page: Page): Promise<{ top: number; bottom: number; viewport: number; page: number }> {
  return page.locator(".week-scroll").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), viewport: window.innerHeight,
      page: document.documentElement.scrollHeight - window.innerHeight };
  });
}

const detail = (page: Page): Locator => page.getByTestId("appointment-detail");

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await revealAppointmentOnCalendar(page, appointmentId);
  await page.locator(`[data-appointment-id="${appointmentId}"]`).first().locator(".calendar-open").click();
  await expect(detail(page)).toBeVisible();
}

// ─── RC-01 · the grid takes the viewport ───────────────────────────────────────────────────

test("@responsive the calendar's scroll box ends at the viewport's foot in every view, and follows it",
  async ({ page, request, tenant }, testInfo) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    await openView(page, "calendar");

    for (const view of ["day", "week"] as const) {
      await page.locator("#calendar-view-select").selectOption(view);
      await page.waitForLoadState("networkidle");
      const box = await scrollBox(page);
      // On a desk the box ends inside the page's own 16px gutter; on a phone the page may scroll
      // (the toolbar's rows are above it) but the box is never a fraction of the height.
      if (!phoneWidth(testInfo)) expect(box.bottom, view).toBeGreaterThanOrEqual(box.viewport - 24);
      expect(box.bottom - box.top, view).toBeGreaterThanOrEqual(Math.min(320, box.viewport - box.top - 24));
    }
    await page.locator("#calendar-agenda-mode").click();
    const agenda = await scrollBox(page);
    if (!phoneWidth(testInfo)) expect(agenda.bottom).toBeGreaterThanOrEqual(agenda.viewport - 24);

    // The month: six rows of content-driven height, with today's week in the box, not 330px cells.
    await page.locator("#calendar-calendar-mode").click();
    await page.locator("#calendar-view-select").selectOption("month");
    await page.waitForLoadState("networkidle");
    const rows = await page.locator(".calendar-month-day").evaluateAll((cells) =>
      cells.map((cell) => Math.round(cell.getBoundingClientRect().height)));
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(100);
    expect(Math.max(...rows)).toBeLessThan(330);
    const today = page.locator(".calendar-month-day.today");
    if (await today.count()) {
      const inBox = await today.evaluate((cell) => {
        const box = document.querySelector(".week-scroll")!.getBoundingClientRect();
        const rect = cell.getBoundingClientRect();
        return rect.top >= box.top && rect.bottom <= box.bottom + 1;
      });
      expect(inBox).toBe(true);
    }

    // A taller viewport gets a taller box: the height is measured, not a constant. Grown from
    // whatever this project's viewport is - a portrait tablet is already taller than a desk.
    if (!phoneWidth(testInfo)) {
      await page.locator("#calendar-view-select").selectOption("day");
      await page.waitForLoadState("networkidle");
      const before = await scrollBox(page);
      const size = page.viewportSize()!;
      await page.setViewportSize({ width: size.width, height: size.height + 200 });
      await expect.poll(async () => (await scrollBox(page)).bottom).toBeGreaterThan(before.bottom + 150);
    }
  });

// ─── RC-02 · the card menu leaves the grid ───────────────────────────────────────────────────

test("every row of a card's menu can be pressed without scrolling the grid, wherever the card sits",
  async ({ page, request, tenant }) => {
    // Late in the day, so the card sits near the foot of the box and the menu has to open above.
    const late = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T16:30` });
    await login(page, tenant.ownerEmail);
    await openView(page, "calendar");
    await revealAppointmentOnCalendar(page, late.id);
    await page.locator(".week-scroll").evaluate((node) => { node.scrollTop = node.scrollHeight; });

    const card = page.locator(`[data-appointment-id="${late.id}"]`).first();
    await card.hover();
    await card.locator("[data-appointment-menu]").click();
    const menu = page.locator(".calendar-action-popover:not([hidden])");
    await expect(menu).toBeVisible();
    // Lifted into the top layer, where the grid's overflow cannot reach it.
    await expect(menu).toHaveAttribute("popover", "manual");
    const rows = await menu.getByRole("menuitem").evaluateAll((items) => items.map((item) => {
      const rect = item.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { name: item.textContent!.trim(), onScreen: rect.top >= 0 && rect.bottom <= window.innerHeight, hit: hit === item || item.contains(hit) };
    }));
    expect(rows.map((row) => row.name)).toEqual(["Check in", "View / Edit", "Move", "Cancel appointment", "No show"]);
    for (const row of rows) { expect(row, row.name).toMatchObject({ onScreen: true, hit: true }); }
    // Escape closes it and hands focus back to the trigger, as before.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(card.locator("[data-appointment-menu]")).toBeFocused();
  });

// ─── RC-05 · where a phone opens ─────────────────────────────────────────────────────────────

test("@responsive a phone opens the week on the selected day's column, and the day on its two groomers",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(!phoneWidth(testInfo), "where the week opens is decided by the viewport, and this is not a phone's");
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const second = await (await request.post("/api/employees", {
      data: { displayName: "Gabriel Groomer", serviceIds: [tenant.serviceId] }
    })).json() as { id: string };
    expect(second.id).toBeTruthy();
    await login(page, tenant.ownerEmail);
    await openView(page, "calendar");

    // Two groomers fit the phone side by side: no horizontal scroll, and neither head is clipped.
    await expect(page.locator("#calendar-list")).toHaveClass(/day-grid/u);
    const day = await page.locator(".week-scroll").evaluate((node) => ({
      overflow: node.scrollWidth - node.clientWidth,
      heads: [...node.querySelectorAll(".day-groomer")].map((head) => head.scrollWidth <= head.clientWidth + 1)
    }));
    expect(day.overflow).toBe(0);
    expect(day.heads).toEqual([true, true]);

    // The week opens with the selected date's column at the left of the box, not the closed Sunday.
    await page.locator("#calendar-view-select").selectOption("week");
    await page.waitForLoadState("networkidle");
    const selected = todayInSalon();
    // The week grid is painted after the load settles; wait for its heads rather than for silence.
    await expect(page.locator(`.week-day-head[data-calendar-date="${selected}"]`)).toBeAttached();
    const week = await page.locator(".week-scroll").evaluate((node, date) => {
      const head = node.querySelector(`.week-day-head[data-calendar-date="${date}"]`)!.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return { scrollLeft: node.scrollLeft, headLeft: Math.round(head.left - box.left), boxWidth: Math.round(box.width) };
    }, selected);
    expect(week.headLeft).toBeGreaterThanOrEqual(0);
    expect(week.headLeft).toBeLessThan(week.boxWidth);
    // Sunday's column is behind the left edge unless today is the Sunday.
    if (new Date(`${selected}T12:00:00`).getDay() !== 0) expect(week.scrollLeft).toBeGreaterThan(0);
  });

// ─── RC-04 · a cancelled visit reads as one ──────────────────────────────────────────────────

test("@responsive a cancelled visit is struck and dimmed on the grid, and the surface says so in a badge and a banner",
  async ({ page, request, tenant }) => {
    const live = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const gone = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T11:00`, petId: tenant.rockyPetId, customerId: tenant.rockyCustomerId });
    const cancelled = await request.post(`/api/appointments/${gone.id}/transition`, { data: { status: "cancelled", version: gone.version } });
    expect(cancelled.ok(), await cancelled.text()).toBeTruthy();
    await login(page, tenant.ownerEmail);
    await openView(page, "calendar");
    await revealAppointmentOnCalendar(page, gone.id);

    const card = page.locator(`[data-appointment-id="${gone.id}"]`).first();
    await expect(card).toHaveClass(/status-cancelled/u);
    expect(await card.evaluate((node) => ({
      opacity: getComputedStyle(node).opacity,
      struck: getComputedStyle(node.querySelector(".appointment-pet")!).textDecorationLine
    }))).toEqual({ opacity: "0.6", struck: "line-through" });
    const other = page.locator(`[data-appointment-id="${live.id}"]`).first();
    expect(await other.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");

    await card.locator(".calendar-open").click();
    await expect(detail(page)).toBeVisible();
    const status = detail(page).getByTestId("appointment-status");
    // The text the suite has always read, in the cards' badge.
    await expect(status).toHaveText("cancelled");
    await expect(status).toHaveClass(/appointment-badge badge-cancelled/u);
    expect(await status.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(11);
    const banner = detail(page).getByTestId("appointment-status-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText("This appointment was cancelled.");
  });

// ─── RC-12 · the dashboard's list is today's ─────────────────────────────────────────────────

test("the dashboard's Salon schedule still lists today after the calendar has been paged elsewhere",
  async ({ page, request, tenant }) => {
    const today = todayInSalon();
    test.skip(new Date(`${today}T12:00:00`).getDay() === 0, "the fixture salon is closed on Sundays, so nothing can be booked today");
    const visit = await createAppointment(request, tenant, { localStart: `${today}T09:00` });
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00`, petId: tenant.mochiPetId, customerId: tenant.sophiaCustomerId });
    await login(page, tenant.ownerEmail);

    const list = page.locator("#today-list");
    await expect(list.locator(`[data-appointment-id="${visit.id}"]`)).toHaveCount(1);
    // Page the calendar to a day that is not today, then come back.
    await openView(page, "calendar");
    await page.locator("#calendar-view-select").selectOption("day");
    await page.waitForLoadState("networkidle");
    await page.locator("#calendar-next-week").click();
    await page.waitForLoadState("networkidle");
    await openView(page, "dashboard");
    await expect(list.locator(`[data-appointment-id="${visit.id}"]`)).toHaveCount(1);
    await expect(list).not.toContainText("No appointments today.");

    // And the row can be ACTED ON: its "Check in" resolves the visit from the today list, which
    // is the only cache holding it now that the grid shows another day.
    const row = list.locator(`[data-appointment-id="${visit.id}"]`);
    await row.locator("[data-appointment-menu]").click();
    await page.locator(".calendar-action-popover:not([hidden])").getByRole("menuitem", { name: "Check in" }).click();
    await expect(page.getByTestId("modal")).toBeVisible();
    await expect(page.getByTestId("modal-pet-name")).toHaveText("Charlie");
    await page.keyboard.press("Escape");
  });

// ─── RC-13 · a nav item the route refuses ────────────────────────────────────────────────────

test("a role without customers.view is not shown Clients, and a refused load is spoken with the chrome intact",
  async ({ page, request, tenant }) => {
    const groomer = await createMember(request, `groomer+${tenant.runId}@pawsh-test.example`, GROOMER);
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, groomer.email, password);
    await openNavigation(page);
    await expect(page.getByTestId("nav-customers")).toBeHidden();

    // The refusal itself, forced the way a stale tab would: the item is uncovered and pressed.
    await openView(page, "calendar");
    await page.locator("#calendar-view-select").selectOption("day");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("nav-customers").evaluate((node) => { (node as HTMLElement).hidden = false; });
    await page.getByTestId("nav-customers").click();
    await expect(page.locator("#toast")).toHaveClass(/show/u);
    await expect(page.locator("#toast")).toContainText("You do not have permission");
    // Landed on a destination this role has, with the toolbar saying what the grid shows.
    await expect(page.locator("body")).toHaveAttribute("data-view", "calendar");
    await expect(page.locator("#calendar-view-select")).toHaveValue("day");
    await expect(page.locator("#calendar-list")).toHaveClass(/day-grid/u);
    await expect(page.getByTestId("nav-customers")).toBeHidden();
  });

// ─── RC-14 · a rate limit is not a sign-out ──────────────────────────────────────────────────

test("a rate-limited /api/me mid-session keeps the operator signed in and retries after the delay it was given",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    await openView(page, "calendar");

    let shape: "429" | "400" | "ok" = "429";
    await page.route("**/api/me", async (route) => {
      if (shape === "429") return route.fulfill({ status: 429, headers: { "retry-after": "1" }, contentType: "application/json",
        body: JSON.stringify({ code: "RATE_LIMITED", error: "Too many requests. Try again in 1 minute." }) });
      if (shape === "400") return route.fulfill({ status: 400, contentType: "application/json",
        body: JSON.stringify({ error: "Rate limit exceeded, retry in 1 seconds" }) });
      return route.continue();
    });
    const resume = () => page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await resume();
    await expect(page.locator("#toast")).toHaveText("Busy, retrying in 1 s");
    await expect(page.locator("#app-view")).toBeVisible();
    await expect(page.locator("#auth-view")).toBeHidden();

    shape = "400";
    await resume();
    await expect(page.locator("#toast")).toHaveText("Busy, retrying in 1 s");
    await expect(page.locator("#app-view")).toBeVisible();

    // The retry lands once the server answers, and the session is exactly where it was.
    shape = "ok";
    await page.waitForTimeout(1_500);
    await expect(page.locator("#app-view")).toBeVisible();
    await expect(page.locator("#calendar")).toBeVisible();
    await page.unroute("**/api/me");
  });

// ─── RC-15 / RC-16 · the settled statement and the phone footers ─────────────────────────────

test("@responsive the settled Check Out keeps its padding, and its footer is two bounded rows on a phone",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(phoneWidth(testInfo), "Check Out is reached from the card menu, which a phone-width grid does not draw; the phone layout is measured by resizing below");
    const { appointment } = await prepareReceipt(request, tenant);
    await login(page, tenant.ownerEmail);
    await openView(page, "calendar");
    await revealAppointmentOnCalendar(page, appointment.id);
    await openCheckout(page, appointment.id);
    const surface = checkoutSurface(page);
    await expect(surface.locator(".checkout-settled")).toBeVisible();

    const measure = () => surface.evaluate((root) => {
      const settled = root.querySelector(".checkout-settled")!;
      const receipt = settled.querySelector(".receipt")!.getBoundingClientRect();
      const foot = root.querySelector(".surface-foot")!.getBoundingClientRect();
      const voidControl = [...root.querySelectorAll("button")].find((button) => /void/iu.test(button.textContent ?? ""));
      return {
        padding: Number.parseFloat(getComputedStyle(settled).paddingLeft),
        receiptLeft: Math.round(receipt.left), receiptRight: Math.round(receipt.right), width: window.innerWidth,
        voidRight: voidControl ? Math.round(voidControl.getBoundingClientRect().right) : null,
        footHeight: Math.round(foot.height),
        balanceTop: Math.round(root.querySelector(".checkout-balance")!.getBoundingClientRect().top),
        doneTop: Math.round(root.querySelector('[data-testid="checkout-done"]')!.getBoundingClientRect().top)
      };
    });
    const desk = await measure();
    expect(desk.padding).toBeGreaterThanOrEqual(16);
    expect(desk.receiptRight).toBeLessThanOrEqual(desk.width - 16);
    expect(desk.voidRight).not.toBeNull();
    expect(desk.voidRight!).toBeLessThanOrEqual(desk.width - 16);

    for (const [width, height] of [[390, 844], [360, 800]] as const) {
      await page.setViewportSize({ width, height });
      const phone = await measure();
      expect(phone.padding, `${width}`).toBeGreaterThanOrEqual(16);
      expect(phone.receiptLeft, `${width}`).toBeGreaterThanOrEqual(16);
      expect(phone.receiptRight, `${width}`).toBeLessThanOrEqual(width - 16);
      expect(phone.footHeight, `${width}`).toBeLessThanOrEqual(130);
      // Balance beside the primary on the first row, the documents beneath.
      expect(Math.abs(phone.balanceTop - phone.doneTop), `${width}`).toBeLessThan(20);
      for (const testid of ["checkout-print-invoice", "checkout-print-receipt", "checkout-ticket", "checkout-done"]) {
        await expect(surface.getByTestId(testid), `${width} ${testid}`).toBeVisible();
      }
    }
  });

test("@responsive the Invoice footer on a phone is the balance and four actions in two rows, with the note in the body",
  async ({ page, request, tenant }, testInfo) => {
    const { appointment } = await prepareReceipt(request, tenant);
    await login(page, tenant.ownerEmail);
    await openView(page, "calendar");
    await openDetail(page, appointment.id);
    await detail(page).getByTestId("appointment-invoice").click();
    const surface = invoiceSurface(page);
    await expect(surface).toBeVisible();
    if (!phoneWidth(testInfo)) await page.setViewportSize({ width: 390, height: 844 });

    const foot = surface.locator(".surface-foot");
    await expect.poll(() => foot.evaluate((node) => Math.round(node.getBoundingClientRect().height))).toBeLessThanOrEqual(130);
    const note = surface.getByTestId("invoice-unavailable-note");
    await expect(note).toBeVisible();
    expect(await note.evaluate((node) => Boolean(node.closest(".surface-foot")))).toBe(false);
    // Disabled, never hidden: both unbuilt controls are on the row, grey and unpressable.
    for (const testid of ["invoice-print-invoice", "invoice-print-receipt", "invoice-send-receipt", "invoice-ask-review"]) {
      await expect(surface.getByTestId(testid), testid).toBeVisible();
    }
    await expect(surface.getByTestId("invoice-send-receipt")).toBeDisabled();
    await expect(surface.getByTestId("invoice-ask-review")).toBeDisabled();
    const rows = await foot.locator("button").evaluateAll((buttons) => new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size);
    expect(rows).toBe(2);

    // Landscape: the same footer, and the document still has room above it.
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => foot.evaluate((node) => Math.round(node.getBoundingClientRect().height))).toBeLessThanOrEqual(130);
  });

// ─── RC-06 · the booking rail on a phone ─────────────────────────────────────────────────────

test("@responsive the booking workspace's client rail is one column on a phone",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(!phoneWidth(testInfo), "the rail's phone layout is decided by the viewport, and this is not a phone's");
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    await page.getByTestId("new-action-trigger").click();
    await page.getByTestId("new-action-menu").getByRole("menuitem", { name: "New Appointment" }).click();
    await page.locator(`[data-booking-client="${tenant.customerId}"]`).click();
    const rail = page.getByTestId("booking-client");
    await expect(rail.getByTestId("booking-client-name")).toBeVisible();
    const layout = await rail.evaluate((node) => {
      const lefts = [...node.children].map((child) => Math.round(child.getBoundingClientRect().left));
      return { display: getComputedStyle(node).display, lefts, width: node.getBoundingClientRect().width };
    });
    expect(layout.display).toBe("block");
    // Every block of the rail starts at the same left edge: one column, nothing beside anything.
    expect(new Set(layout.lefts).size).toBe(1);
    const name = rail.getByTestId("booking-client-name");
    expect(await name.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(layout.width * 0.6);
  });

// ─── RC-03 · only the safety alert is an alarm ───────────────────────────────────────────────

test("a behaviour note reads neutral under the pet and on the agenda, and only the safety alert is red",
  async ({ page, request, tenant }) => {
    const charlie = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const rocky = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T11:00`, petId: tenant.rockyPetId, customerId: tenant.rockyCustomerId });
    await login(page, tenant.ownerEmail);
    await openView(page, "calendar");
    await openDetail(page, charlie.id);
    const notes = detail(page).getByTestId("appointment-care-notes");
    await expect(notes).toContainText("Behavior: Friendly and calm.");
    const danger = "rgb(179, 38, 30)";
    expect(await notes.locator(".care-note").first().evaluate((node) => getComputedStyle(node).color)).not.toBe(danger);
    await expect(notes.locator(".care-alarm")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(detail(page)).toBeHidden();

    await openDetail(page, rocky.id);
    const alarm = detail(page).getByTestId("appointment-care-notes").locator(".care-alarm");
    await expect(alarm).toContainText("Safety alert: May snap during nail handling.");
    expect(await alarm.evaluate((node) => getComputedStyle(node).color)).toBe(danger);
    await page.keyboard.press("Escape");

    await page.locator("#calendar-agenda-mode").click();
    const rockyRow = page.locator(`.agenda-entry[data-appointment-id="${rocky.id}"]`);
    await expect(rockyRow.locator(".agenda-warning")).toContainText("Safety alert");
    await expect(rockyRow.locator(".agenda-note")).toHaveCount(3);
    await expect(rockyRow.locator(".appointment-status")).toHaveClass(/appointment-badge/u);
    const charlieRow = page.locator(`.agenda-entry[data-appointment-id="${charlie.id}"]`);
    await expect(charlieRow.locator(".agenda-warning")).toHaveCount(0);
    await expect(charlieRow.locator(".agenda-note")).toHaveCount(2);
  });

// ─── RC-08 · the dialog footer on a phone ────────────────────────────────────────────────────

test("@responsive a long dialog's Save is on screen on a phone without scrolling the form",
  async ({ page, tenant }, testInfo) => {
    test.skip(!phoneWidth(testInfo), "the sticky footer is a phone rule, and this is not a phone's viewport");
    await login(page, tenant.ownerEmail);
    await page.getByTestId("new-action-trigger").click();
    await page.getByTestId("new-action-menu").getByRole("menuitem", { name: "New Block Time" }).click();
    const modal = page.getByTestId("modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("Block Time");
    // No generic kicker above the title.
    await expect(modal.locator(".modal-head .eyebrow")).toHaveCount(0);
    const fit = await modal.evaluate((dialog) => {
      const actions = dialog.querySelector(".modal-actions")!.getBoundingClientRect();
      const submit = dialog.querySelector('[data-testid="modal-submit"]')!.getBoundingClientRect();
      return { actionsBottom: Math.round(actions.bottom), submitBottom: Math.round(submit.bottom), viewport: window.innerHeight };
    });
    expect(fit.submitBottom).toBeLessThanOrEqual(fit.viewport);
    expect(fit.actionsBottom).toBeLessThanOrEqual(fit.viewport);
    await page.keyboard.press("Escape");
  });

// ─── RC-17 · the rail leads with the visit's own pet ─────────────────────────────────────────

test("the appointment rail leads with the visit's own pet and labels a note's kind",
  async ({ page, request, tenant }) => {
    const boba = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00`, petId: tenant.bobaPetId, customerId: tenant.sophiaCustomerId });
    await login(page, tenant.ownerEmail);
    await openView(page, "calendar");
    await openDetail(page, boba.id);
    const rail = detail(page).locator(".surface-rail");
    await expect(rail.getByTestId("pet-card-current")).toContainText("Boba");
    await expect(rail.locator(".pet-card").first()).toHaveAttribute("data-testid", "pet-card-current");
    await expect(rail.locator(".pet-card").first()).toContainText("This visit");
    const note = rail.locator(".pet-card").first().locator(".pet-note.alert");
    await expect(note).toContainText("Safety alert: Do not shave coat.");
    await expect(note.locator(".note-kind")).toHaveText("Safety alert:");
    await expect(rail).not.toContainText("[safety alert]");
    // One column of facts: every label starts at the same left edge.
    const lefts = await rail.locator(".pet-card").first().locator(".pet-fact-grid dt").evaluateAll((cells) =>
      new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().left))).size);
    expect(lefts).toBe(1);
  });

// ─── RC-05 / RC-09 · the drop names the move and the card it lands as is shown ───────────────

test("a drop asks with the pet and both times, and the card it lands as is ringed in the box",
  async ({ page, request, tenant }) => {
    const visit = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    await openView(page, "calendar");
    await revealAppointmentOnCalendar(page, visit.id);
    await dragAppointmentToSlot(page, { appointmentId: visit.id, slot: `${tenant.anchor}T11:00`, groomerId: tenant.employeeId });
    const question = page.getByTestId("reschedule-confirm-question");
    await expect(question).toContainText(/^Move Charlie from 9:00 AM to 11:00 AM on /u);
    await page.getByTestId("stacked-dialog-confirm").click();
    const card = page.locator(`[data-appointment-id="${visit.id}"]`).first();
    await expect(card).toHaveClass(/calendar-revealed/u);
    await expect(card.locator("time")).toContainText("11:00");
    const inBox = await card.evaluate((node) => {
      const box = document.querySelector(".week-scroll")!.getBoundingClientRect();
      const at = node.getBoundingClientRect();
      return at.top >= box.top && at.bottom <= box.bottom + 1;
    });
    expect(inBox).toBe(true);
  });
