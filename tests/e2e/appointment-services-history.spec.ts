import { test, expect, login, createAppointment, createMember, ownerPermissions, password } from "./fixtures/tenant.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { permissionPresets } from "@pawsh/domain";
import { revealAppointmentOnCalendar } from "./helpers/calendar.js";
import { expectCriticalTarget, expectTouchTarget } from "./helpers/responsive.js";

/**
 * THE WORK LIST IS EDITED LINE BY LINE, AND THE HISTORY SAYS WHAT CHANGED.
 *
 * A booked service used to be a fixed copy of the catalog: the only way to change what a visit
 * reserved or charged was to change the catalog for every dog. The surface now states each line
 * as it stands FOR THIS VISIT - `$price · N min` - with a pencil that opens the line's own editor,
 * and `+ Add service` beside the list for the catalog selector, which is now for adding and
 * removing only. What this walk holds in a real browser, against the real routes:
 *
 *   A MANAGER changes the minutes and then the price of a line; the row, the header's scheduled
 *       minutes, the total and the calendar all follow, and the history reads `90 → 105 min` and
 *       `$85.00 → $95.00` under the manager's name, newest first.
 *   A GROOMER may lengthen their own visit and may not re-price it: the price is text with the key
 *       named, and the request they send carries no `priceMinor` at all. Adding a service through
 *       the catalog afterwards keeps the minutes they set, because the selector sends every
 *       existing line with its id.
 *   BLOCKED TIME refuses a duration that would run into it, with the server's sentence in the
 *       dialog and nothing written.
 *   THE HISTORY is collapsed by default, newest first, reads a reschedule as from → to, and shows
 *       money only to a role that may see it - the same settled visit, two roles, two feeds.
 *   ON A PHONE the editor is a real dialog with 44px controls.
 *
 * WHY THESE ARE BROWSER SPECS. What each function DRAWS is held deterministically in
 * `tests/ui/appointment-services-history.test.ts`. What cannot be asserted there: that a save
 * persists through the real route, that the surface redraws under the operator's hand, that a
 * refusal leaves the row untouched, and what two real sessions with two real roles are shown.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");
const at = (page: Page, testid: string): Locator => detail(page).getByTestId(testid);
const modal = (page: Page): Locator => page.getByTestId("modal");
const GROOMER = [...permissionPresets.groomer!];

interface Line { id: string; serviceId: string; name: string; durationMinutes: number; priceMinor: number; resolutionSource: string }
interface Visit { id: string; version: number; startAt: string; endAt: string; services: Line[] }

async function visit(api: APIRequestContext, appointmentId: string): Promise<Visit> {
  const response = await api.get(`/api/appointments/${appointmentId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as Visit;
}

/** The navigation is behind a toggle on a phone. */
async function openNavigation(page: Page): Promise<void> {
  if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-calendar").isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
}

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await openNavigation(page);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await revealAppointmentOnCalendar(page, appointmentId);
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

/** The work-list row for one line, by its id. */
function row(page: Page, lineId: string): Locator {
  return detail(page).locator(`[data-testid="appointment-service-row"][data-line-id="${lineId}"]`);
}

/** Opens the history and returns its entries, newest first. */
async function history(page: Page): Promise<Locator> {
  const disclosure = at(page, "appointment-activity");
  if (!(await disclosure.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await disclosure.locator("summary").click();
  }
  await expect(disclosure).toHaveAttribute("open", "");
  return disclosure.locator(".activity-feed li");
}

/** Every write to a service line or the work list, with the body it carried. */
function watchServiceWrites(page: Page): Array<{ method: string; path: string; body: Record<string, unknown> }> {
  const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  page.on("request", (outgoing) => {
    if (!["PATCH", "PUT"].includes(outgoing.method())) return;
    const path = new URL(outgoing.url()).pathname;
    if (!/\/api\/appointments\/[^/]+\/services(\/[^/]+)?$/u.test(path)) return;
    seen.push({ method: outgoing.method(), path, body: (outgoing.postDataJSON() ?? {}) as Record<string, unknown> });
  });
  return seen;
}

async function link(api: APIRequestContext, employeeId: string, membershipId: string): Promise<void> {
  const linked = await api.put(`/api/employees/${employeeId}`, { data: { membershipId } });
  expect(linked.ok(), await linked.text()).toBeTruthy();
}

/** Completed, billed and paid in full through the owner's API. */
async function settle(api: APIRequestContext, appointment: { id: string; version: number }): Promise<void> {
  let version = appointment.version;
  for (const status of ["checked_in", "in_service", "completed"]) {
    const moved = await api.post(`/api/appointments/${appointment.id}/transition`, { data: { status, version } });
    expect(moved.ok(), await moved.text()).toBeTruthy();
    version = ((await moved.json()) as { version: number }).version;
  }
  const billed = await api.post(`/api/appointments/${appointment.id}/checkout`, {
    headers: { "Idempotency-Key": crypto.randomUUID() }, data: { discountMinor: 0, discountType: "manual", tipMinor: 0 }
  });
  expect(billed.ok(), await billed.text()).toBeTruthy();
  const invoice = (await billed.json()) as { id: string; balanceMinor: number };
  const paid = await api.post(`/api/invoices/${invoice.id}/payments`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { amountMinor: invoice.balanceMinor, expectedBalanceMinor: invoice.balanceMinor, method: "cash" }
  });
  expect(paid.ok(), await paid.text()).toBeTruthy();
}

test("a manager edits a line's minutes and then its price, and the history says so by name, newest first",
  async ({ page, request, tenant }) => {
    const manager = await createMember(request, `manager+${tenant.runId}@pawsh-test.example`, ownerPermissions);
    const appointment = await createAppointment(request, tenant);
    const [line] = (await visit(request, appointment.id)).services;
    await login(page, manager.email, password);
    const writes = watchServiceWrites(page);
    await openDetail(page, appointment.id);

    // ── THE ROW AS BOOKED: the catalog's figures, no mark, and a pencil ─────────────────────
    await expect(row(page, line!.id)).toContainText("$85.00 · 90 min");
    await expect(row(page, line!.id).getByTestId("appointment-service-edited")).toHaveCount(0);
    await expect(at(page, "appointment-adjust-services")).toHaveText("+ Add service");
    await expect(detail(page).locator(".surface-subhead")).toContainText("scheduled 90 min");
    // Collapsed until asked for, with the count on the fold.
    await expect(at(page, "appointment-activity")).not.toHaveAttribute("open", "");
    await expect(at(page, "appointment-activity").locator("[data-activity-count]")).toHaveText("(1)");

    // ── MINUTES ────────────────────────────────────────────────────────────────────────────
    await row(page, line!.id).getByTestId("appointment-service-edit").click();
    await expect(modal(page)).toBeVisible();
    await expect(page.locator("#modal-title")).toHaveText("Edit service");
    await expect(modal(page).getByTestId("service-line-name")).toHaveText("Full Groom");
    // A manager holds the price key, so the price is a field.
    await expect(modal(page).getByTestId("field-price")).toHaveValue("85.00");
    await modal(page).getByTestId("field-durationMinutes").fill("105");
    await page.getByTestId("modal-submit").click();
    await expect(modal(page)).toBeHidden();

    await expect(row(page, line!.id)).toContainText("$85.00 · 105 min");
    await expect(row(page, line!.id).getByTestId("appointment-service-edited")).toBeVisible();
    await expect(row(page, line!.id).getByTestId("appointment-service-catalog")).toHaveText("Catalog: $85.00 · 90 min");
    await expect(detail(page).locator(".surface-subhead")).toContainText("scheduled 105 min");
    await expect(detail(page).locator(".appointment-service-total")).toContainText("105 min · $85.00");
    const lengthened = await visit(request, appointment.id);
    expect(lengthened.services[0]!.durationMinutes).toBe(105);
    expect(lengthened.services[0]!.resolutionSource).toBe("manual");
    expect((new Date(lengthened.endAt).getTime() - new Date(lengthened.startAt).getTime()) / 60000).toBe(105);

    // ── PRICE ──────────────────────────────────────────────────────────────────────────────
    await row(page, line!.id).getByTestId("appointment-service-edit").click();
    await expect(modal(page).getByTestId("field-durationMinutes")).toHaveValue("105");
    await modal(page).getByTestId("field-price").fill("95");
    await page.getByTestId("modal-submit").click();
    await expect(modal(page)).toBeHidden();
    await expect(row(page, line!.id)).toContainText("$95.00 · 105 min");
    await expect(detail(page).locator(".appointment-service-total")).toContainText("105 min · $95.00");
    expect((await visit(request, appointment.id)).services[0]!.priceMinor).toBe(9500);

    // Only what changed went over the wire, each time.
    expect(writes.map((write) => write.body)).toEqual([
      { version: expect.any(Number), durationMinutes: 105 },
      { version: expect.any(Number), priceMinor: 9500 }
    ]);

    // ── THE HISTORY: what · who · when, from → to, newest first ────────────────────────────
    await expect(at(page, "appointment-activity").locator("[data-activity-count]")).toHaveText("(3)");
    const feed = await history(page);
    await expect(feed).toHaveCount(3);
    await expect(feed.nth(0)).toContainText("Price changed");
    await expect(feed.nth(0)).toContainText("Full Groom: $85.00 → $95.00");
    await expect(feed.nth(0)).toContainText(manager.email.split("@")[0]!);
    await expect(feed.nth(1)).toContainText("Duration changed");
    await expect(feed.nth(1)).toContainText("Full Groom: 90 → 105 min");
    await expect(feed.nth(2)).toContainText("Created");
    // No id is printed anywhere in it.
    await expect(at(page, "appointment-activity")).not.toContainText(appointment.id.slice(0, 8));
    await expect(at(page, "appointment-activity")).not.toContainText(line!.id.slice(0, 8));

    // ── A RESCHEDULE READS FROM → TO ───────────────────────────────────────────────────────
    const current = await visit(request, appointment.id);
    const moved = await request.patch(`/api/appointments/${appointment.id}/schedule`, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { employeeId: tenant.employeeId, localStart: `${tenant.anchor}T13:00`,
        expectedLocationVersion: tenant.locationVersion, version: current.version }
    });
    expect(moved.ok(), await moved.text()).toBeTruthy();
    await detail(page).locator("[data-surface-close]").click();
    await expect(detail(page)).toBeHidden();
    await page.waitForLoadState("networkidle");
    await openDetail(page, appointment.id);
    const after = await history(page);
    await expect(after.nth(0)).toContainText("Rescheduled");
    await expect(after.nth(0)).toContainText(/9:00 AM → .*1:00 PM/u);
  });

/**
 * A role WITHOUT `appointments.service_price_edit`. The shipped Groomer preset holds the key now -
 * a groomer may price their own work - so the read-only price is a custom role's, built here from
 * the preset with that one key left out, and it says why in words rather than as the key.
 */
test("a role without Edit service prices is shown the price as text, with the reason, and never a disabled input",
  async ({ page, request, tenant }) => {
    const keyless = GROOMER.filter((permission) => permission !== "appointments.service_price_edit");
    const grace = await createMember(request, `grace-keyless+${tenant.runId}@pawsh-test.example`, keyless);
    await link(request, tenant.employeeId, grace.membershipId);
    const appointment = await createAppointment(request, tenant);
    const [line] = (await visit(request, appointment.id)).services;
    await login(page, grace.email, password);
    await openDetail(page, appointment.id);

    await row(page, line!.id).getByTestId("appointment-service-edit").click();
    await expect(modal(page)).toBeVisible();
    // The price is a value with its reason, not a field of any kind.
    await expect(modal(page).getByTestId("service-line-price-readonly")).toBeVisible();
    await expect(modal(page).getByTestId("service-line-price-value")).toHaveText("$85.00");
    await expect(modal(page).getByTestId("service-line-price-readonly")).toContainText("Price changes need Edit service prices.");
    await expect(modal(page).getByTestId("service-line-price-readonly")).not.toContainText("service_price_edit");
    await expect(modal(page).getByTestId("field-price")).toHaveCount(0);
    await expect(modal(page).locator("input[disabled]")).toHaveCount(0);
    // The duration is still theirs to change.
    await modal(page).getByTestId("field-durationMinutes").fill("120");
    await page.getByTestId("modal-submit").click();
    await expect(modal(page)).toBeHidden();
    await expect(row(page, line!.id)).toContainText("$85.00 · 120 min");
  });

test("a groomer lengthens their own visit, may price it, and adding a service keeps the minutes they set",
  async ({ page, request, tenant }) => {
    const grace = await createMember(request, `grace+${tenant.runId}@pawsh-test.example`, GROOMER);
    await link(request, tenant.employeeId, grace.membershipId);
    const appointment = await createAppointment(request, tenant);
    const [line] = (await visit(request, appointment.id)).services;
    await login(page, grace.email, password);
    const writes = watchServiceWrites(page);
    await openDetail(page, appointment.id);

    await row(page, line!.id).getByTestId("appointment-service-edit").click();
    await expect(modal(page)).toBeVisible();
    // The Groomer preset holds `appointments.service_price_edit`, so the price is a field here -
    // offered by `allowed()`, with no read-only text and no key anywhere on the dialog.
    await expect(modal(page).getByTestId("field-price")).toHaveValue("85.00");
    await expect(modal(page).getByTestId("service-line-price-readonly")).toHaveCount(0);
    await expect(modal(page).locator("input[disabled]")).toHaveCount(0);
    await modal(page).getByTestId("field-durationMinutes").fill("120");
    await page.getByTestId("modal-submit").click();
    await expect(modal(page)).toBeHidden();

    await expect(row(page, line!.id)).toContainText("$85.00 · 120 min");
    await expect(row(page, line!.id).getByTestId("appointment-service-edited")).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe("PATCH");
    // The price was offered and left alone: an unchanged field is not re-sent as a price edit.
    expect(Object.keys(writes[0]!.body).sort()).toEqual(["durationMinutes", "version"]);

    // ── + ADD SERVICE, THROUGH THE CATALOG, KEEPS THE EDITED LINE ─────────────────────────
    await at(page, "appointment-adjust-services").click();
    const catalog = page.locator("#modal-fields");
    await expect(catalog).toBeVisible();
    await expect(catalog.locator('input[name="serviceIds"]:checked')).toHaveCount(1);
    await catalog.getByRole("checkbox", { name: /^Nail Trim \$20\.00/u }).check();
    await page.getByTestId("modal-submit").click();
    await expect(catalog).toBeHidden();

    expect(writes).toHaveLength(2);
    expect(writes[1]!.method).toBe("PUT");
    expect(writes[1]!.body).not.toHaveProperty("serviceIds");
    expect(writes[1]!.body.lines).toEqual([{ id: line!.id, serviceId: line!.serviceId }, { serviceId: expect.any(String) }]);

    await expect(detail(page).getByTestId("appointment-service-row")).toHaveCount(2);
    await expect(row(page, line!.id)).toContainText("$85.00 · 120 min");
    await expect(row(page, line!.id).getByTestId("appointment-service-edited")).toBeVisible();
    const both = await visit(request, appointment.id);
    expect(both.services.map((each) => [each.name, each.durationMinutes])).toEqual([["Full Groom", 120], ["Nail Trim", 30]]);
    expect(both.services[0]!.id).toBe(line!.id);

    const feed = await history(page);
    await expect(feed.nth(0)).toContainText("Services changed");
    await expect(feed.nth(0)).toContainText("Added Nail Trim");
    await expect(feed.nth(0)).toContainText("Grace Groomer");
    await expect(feed.nth(1)).toContainText("Full Groom: 90 → 120 min");
  });

test("a duration that would run into blocked time is refused with the server's sentence, and nothing is saved",
  async ({ page, request, tenant }) => {
    const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    const [line] = (await visit(request, appointment.id)).services;
    // Lunch, right after the visit's 90 minutes: 10:30 to 11:00.
    const block = await request.post("/api/blocked-times", { data: {
      employeeId: tenant.employeeId, locationId: tenant.locationId,
      localStart: `${tenant.anchor}T10:30`, localEnd: `${tenant.anchor}T11:00`,
      reason: "Lunch", expectedLocationVersion: tenant.locationVersion
    } });
    expect(block.ok(), await block.text()).toBeTruthy();
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    await row(page, line!.id).getByTestId("appointment-service-edit").click();
    await modal(page).getByTestId("field-durationMinutes").fill("120");
    await page.getByTestId("modal-submit").click();

    // The dialog stays, carrying the refusal, and offers nothing to override it with.
    await expect(modal(page)).toBeVisible();
    await expect(page.locator("#modal-error")).toContainText("has time blocked out during that time");
    await expect(page.getByTestId("confirm-conflict-override")).toHaveCount(0);
    const unchanged = await visit(request, appointment.id);
    expect(unchanged.services[0]!.durationMinutes).toBe(90);
    expect(unchanged.services[0]!.resolutionSource).not.toBe("manual");

    await page.locator("#modal .modal-actions .close").click();
    await expect(modal(page)).toBeHidden();
    await expect(row(page, line!.id)).toContainText("$85.00 · 90 min");
    await expect(row(page, line!.id).getByTestId("appointment-service-edited")).toHaveCount(0);
  });

test("the history shows a settled visit's money to the owner and none of it to the groomer",
  async ({ page, request, tenant }) => {
    const grace = await createMember(request, `grace+${tenant.runId}@pawsh-test.example`, GROOMER);
    await link(request, tenant.employeeId, grace.membershipId);
    const appointment = await createAppointment(request, tenant);
    await settle(request, appointment);

    // ── THE GROOMER: the visit's own rows, and not one amount ─────────────────────────────
    await login(page, grace.email, password);
    await openDetail(page, appointment.id);
    await expect(at(page, "appointment-activity")).not.toHaveAttribute("open", "");
    const theirs = await history(page);
    await expect(theirs.first()).toContainText("Ready for pickup");
    await expect(theirs.filter({ hasText: "Checked in" })).toHaveCount(1);
    await expect(theirs.filter({ hasText: "Created" })).toHaveCount(1);
    await expect(theirs.filter({ hasText: "Payment recorded" })).toHaveCount(0);
    await expect(theirs.filter({ hasText: "Invoiced" })).toHaveCount(0);
    await expect(at(page, "appointment-activity")).not.toContainText("$");
    const groomerRows = await theirs.count();

    // ── THE OWNER: the same visit, with the bill and the tender on it, newest first ───────
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);
    const owners = await history(page);
    await expect(owners.nth(0)).toContainText("Payment recorded");
    await expect(owners.nth(0)).toContainText(/\$\d+\.\d\d by cash/u);
    await expect(owners.nth(1)).toContainText("Invoiced");
    await expect(owners.nth(1)).toContainText(/\$\d+\.\d\d/u);
    await expect(owners.filter({ hasText: "Ready for pickup" })).toHaveCount(1);
    // More rows for the owner than for the groomer, and the fold says so.
    const count = await at(page, "appointment-activity").locator("[data-activity-count]").textContent();
    expect(Number(count!.replace(/[()]/gu, ""))).toBeGreaterThan(groomerRows);
    await expect(owners).toHaveCount(Number(count!.replace(/[()]/gu, "")));
  });

test("@responsive the line editor is a real dialog on a phone, with 44px controls",
  async ({ page, request, tenant }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, "the coarse-pointer floor is exercised by the touch profiles");
    const appointment = await createAppointment(request, tenant);
    const [line] = (await visit(request, appointment.id)).services;
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    const pencil = row(page, line!.id).getByTestId("appointment-service-edit");
    await expectTouchTarget(pencil);
    await pencil.click();
    await expect(modal(page)).toBeVisible();
    const viewport = page.viewportSize()!;
    const box = (await modal(page).boundingBox())!;
    // The shared dialog spans the phone inside the product's own gutter (`calc(100vw - 30px)`).
    expect(box.width, "the dialog fills the phone").toBeGreaterThanOrEqual(viewport.width - 40);
    expect(box.x + box.width, "and never past its edge").toBeLessThanOrEqual(viewport.width + 1);
    await expectCriticalTarget(modal(page).getByTestId("field-durationMinutes"));
    await expectCriticalTarget(modal(page).getByTestId("field-price"));
    await expectTouchTarget(page.getByTestId("modal-submit"));
    await expectTouchTarget(page.locator("#modal .modal-actions .close"));

    await modal(page).getByTestId("field-durationMinutes").fill("100");
    await page.getByTestId("modal-submit").click();
    await expect(modal(page)).toBeHidden();
    await expect(row(page, line!.id)).toContainText("100 min");
  });
