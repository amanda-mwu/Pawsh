import {
  test,
  expect,
  login,
  createAppointment,
  completeAppointment,
  createMember,
  appointmentAction,
  password
} from "./fixtures/tenant.js";
import { permissionPresets } from "@pawsh/domain";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { revealAppointmentOnCalendar } from "./helpers/calendar.js";
import { chooseMethod } from "./helpers/checkout.js";

/**
 * QA round 2, in a browser.
 *
 *   C  client credit lands, the second tender fails: the screen names the credit and the exact
 *      remainder, a retry takes only the remainder on the same invoice, and the Receipt waits
 *   D  a Check In on a visit dated after today asks first, in the shared stacked dialog
 *   A  the service note is writable on a scheduled visit and writing it does not check the pet in
 *   B  without `customers.contact_info` no phone, email or address row is drawn anywhere
 *   F  calendar card text is drawn at the shared card size
 *
 * The fixture's `anchor` is next Monday, so every visit created on it is dated after today.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");

/** Reaches a destination the way the viewport offers it: on a phone the rail is behind a toggle. */
async function openView(page: Page, testid: string): Promise<void> {
  if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId(testid).isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
  await page.getByTestId(testid).click();
}

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await openView(page, "nav-calendar");
  await page.waitForLoadState("networkidle");
  await revealAppointmentOnCalendar(page, appointmentId);
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).filter({ visible: true }).first().click();
  await expect(detail(page)).toBeVisible();
}

async function visit(api: APIRequestContext, appointmentId: string) {
  const response = await api.get(`/api/appointments/${appointmentId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { status: string; operationalNotes: string | null; invoiceId: string | null };
}

async function grantCredit(api: APIRequestContext, customerId: string, amountMinor: number): Promise<void> {
  const response = await api.post(`/api/customers/${customerId}/credit`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { kind: "grant", amountMinor, reason: "Round 2 goodwill" }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

// ─── C ──────────────────────────────────────────────────────────────────────────────────────

test("credit lands, the card fails: the remainder is named and retried on the same invoice",
  async ({ page, request, tenant }) => {
    const appointment = await completeAppointment(request, tenant);
    await grantCredit(request, tenant.customerId, 4000);
    await login(page, tenant.ownerEmail);
    await openView(page, "nav-calendar");
    await revealAppointmentOnCalendar(page, appointment.id);
    await (await appointmentAction(page.locator(`[data-appointment-id="${appointment.id}"]`), "appointment-completed")).click();
    await expect(page.getByTestId("checkout-surface")).toBeVisible();

    // The SECOND payment POST - the card - fails; the credit before it reaches the server.
    const posted: Array<{ method: string; amountMinor: number }> = [];
    const checkoutPosts: string[] = [];
    page.on("request", (outgoing) => {
      if (outgoing.method() === "POST" && new URL(outgoing.url()).pathname.endsWith("/checkout")) {
        checkoutPosts.push(outgoing.url());
      }
    });
    let failOnce = true;
    await page.route("**/api/invoices/*/payments", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON() as { method: string; amountMinor: number };
      posted.push(body);
      if (body.method !== "client_credit" && failOnce) {
        failOnce = false;
        // A refusal the route really gives a tender: the balance moved under the screen. A 4xx,
        // because a 5xx is a server fault the fixture rightly fails on.
        return route.fulfill({ status: 409, contentType: "application/json",
          body: JSON.stringify({ code: "STALE_FINANCIAL_STATE",
            error: "The invoice balance changed; review the current balance", balanceMinor: 5201 }) });
      }
      return route.continue();
    });

    await page.getByTestId("checkout-credit-toggle").check();
    await chooseMethod(page, "Card");
    await page.getByTestId("checkout-submit").click();

    // Said plainly: what credit covered, that the card did not go through, and what is owed.
    await expect(page.getByTestId("checkout-error")).toHaveText(
      "Client credit of $40.00 was applied. The Card payment did not go through: The invoice balance changed; review the current balance. "
      + "$52.01 remaining amount due. Take it below to finish."
    );
    await expect(page.getByTestId("checkout-settlement-progress"))
      .toHaveText("Settlement in progress · Client credit of $40.00 applied · $52.01 remaining amount due");
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $52.01");
    // Collecting against THIS invoice, the credit spent and not offered again, no Receipt yet.
    await expect(page.getByTestId("checkout-frozen")).toContainText("already raised");
    await expect(page.getByTestId("checkout-credit-toggle")).toHaveCount(0);
    await expect(page.getByTestId("field-pay")).toHaveValue("52.01");
    await expect(page.getByTestId("checkout-print-receipt")).toHaveCount(0);
    await expect(page.getByTestId("checkout-print-invoice")).toBeVisible();
    const partial = await visit(request, appointment.id);
    expect(partial.invoiceId).not.toBeNull();

    // The retry takes the remainder only.
    await chooseMethod(page, "Cash");
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $0.00");
    await expect(page.getByTestId("checkout-done")).toBeVisible();
    await expect(page.getByTestId("checkout-print-receipt")).toBeVisible();

    expect(posted.map((each) => `${each.method}:${each.amountMinor}`))
      .toEqual(["client_credit:4000", "external_card:5201", "cash:5201"]);
    expect(checkoutPosts).toHaveLength(1);
    expect((await visit(request, appointment.id)).invoiceId).toBe(partial.invoiceId);
    const ledger = await (await request.get(`/api/customers/${tenant.customerId}/credit`)).json() as {
      balanceMinor: number; usedMinor: number;
    };
    expect(ledger.usedMinor).toBe(4000);
    expect(ledger.balanceMinor).toBe(0);
    const receipt = await (await request.get(`/api/invoices/${partial.invoiceId}/receipt`)).json() as {
      invoice: { status: string; balanceMinor: number }; payments: Array<{ method: string; status: string }>;
    };
    expect(receipt.invoice.status).toBe("paid");
    expect(receipt.payments.filter((payment) => payment.status === "recorded").map((payment) => payment.method))
      .toEqual(["client_credit", "cash"]);
  });

// ─── D ──────────────────────────────────────────────────────────────────────────────────────

test("@responsive a Check In dated after today asks first: Cancel leaves it, Confirm checks it in", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T10:00` });
  await login(page, tenant.ownerEmail);
  await openDetail(page, appointment.id);

  await detail(page).getByTestId("appointment-check-in").click();
  const question = page.getByTestId("future-check-in-question");
  await expect(page.getByTestId("stacked-dialog")).toBeVisible();
  await expect(page.locator("#stacked-dialog-title")).toHaveText("Check in early?");
  await expect(question).toContainText(" at 10:00 AM");
  await expect(question).toContainText("not today");
  await page.getByTestId("stacked-dialog-dismiss").click();
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
  await expect(detail(page)).toBeVisible();
  expect((await visit(request, appointment.id)).status).toBe("scheduled");

  // Escape is a Cancel too.
  await detail(page).getByTestId("appointment-check-in").click();
  await expect(question).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
  expect((await visit(request, appointment.id)).status).toBe("scheduled");

  await detail(page).getByTestId("appointment-check-in").click();
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect.poll(async () => (await visit(request, appointment.id)).status).toBe("checked_in");
});

test("the card menu's Check In asks the same question before its own form", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T11:00` });
  await login(page, tenant.ownerEmail);
  await openView(page, "nav-calendar");
  await revealAppointmentOnCalendar(page, appointment.id);
  const card = page.locator(`[data-appointment-id="${appointment.id}"]`);

  await (await appointmentAction(card, "appointment-scheduled")).click();
  await expect(page.getByTestId("future-check-in-question")).toBeVisible();
  await expect(page.getByTestId("stacked-dialog-confirm")).toHaveText("Check In");
  // The menu closed when it handed over, so ONE Escape answers the question and leaves nothing open.
  await expect(page.locator(".calendar-action-popover:not([hidden])")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
  await expect(page.locator(".calendar-action-popover:not([hidden])")).toHaveCount(0);
  // Cancel means nothing else opens and nothing moves.
  await expect(page.getByTestId("modal")).toBeHidden();
  expect((await visit(request, appointment.id)).status).toBe("scheduled");

  await (await appointmentAction(card, "appointment-scheduled")).click();
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(page.getByTestId("modal")).toBeVisible();
  await page.getByTestId("modal-submit").click();
  await expect.poll(async () => (await visit(request, appointment.id)).status).toBe("checked_in");
});

test("the pet's standing actions sit quietly at the left of the profile footer", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await openView(page, "nav-customers");
  await page.locator(`[data-customer-id="${tenant.customerId}"] .clients-name .customer-detail`).click();
  await expect(page.getByTestId("client-profile-view")).toBeVisible();
  await page.locator(`[data-pet-profile="${tenant.petId}"]`).filter({ visible: true }).first().click();
  const dialog = page.getByTestId("pet-profile-dialog");
  await expect(dialog).toBeVisible();
  const standing = dialog.getByTestId("pet-profile-standing");
  await expect(standing.getByTestId("pet-deceased")).toHaveClass(/text-button/u);
  await expect(standing.getByTestId("pet-deceased")).not.toHaveClass(/secondary/u);
  const pass = await standing.getByTestId("pet-deceased").boundingBox();
  const close = await dialog.locator(".pet-profile-actions .close").boundingBox();
  expect(pass!.x).toBeLessThan(close!.x - 100);
});

// ─── A ──────────────────────────────────────────────────────────────────────────────────────

test("@responsive a receptionist writes the service note on a scheduled visit, and the visit stays scheduled",
  async ({ page, request, tenant }) => {
    const receptionist = await createMember(request, `desk+${tenant.runId}@pawsh-test.example`,
      [...permissionPresets.receptionist!]);
    expect(permissionPresets.receptionist).not.toContain("operations.perform_service");
    const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T13:00` });
    await login(page, receptionist.email, password);
    await openDetail(page, appointment.id);

    await expect(detail(page).getByTestId("appointment-service-note-pending")).toHaveCount(0);
    const edit = detail(page).getByTestId("appointment-service-note-edit");
    await expect(edit).toHaveText("Add");
    await expect(edit).toBeEnabled();
    await edit.click();
    await detail(page).locator("textarea").last().fill("Owner called: nervous about the dryer.");
    await detail(page).getByTestId("appointment-service-note-save").click();
    await expect(detail(page).getByTestId("appointment-service-note")).toHaveText("Owner called: nervous about the dryer.");
    const after = await visit(request, appointment.id);
    expect(after.status).toBe("scheduled");
    expect(after.operationalNotes).toBe("Owner called: nervous about the dryer.");
  });

// ─── B ──────────────────────────────────────────────────────────────────────────────────────

test("without customers.contact_info no phone, email or address row is drawn", async ({ page, request, tenant }) => {
  const withoutKey = [...permissionPresets.receptionist!].filter((key) => key !== "customers.contact_info");
  const member = await createMember(request, `nocontact+${tenant.runId}@pawsh-test.example`, withoutKey);
  await login(page, member.email, password);

  await openView(page, "nav-customers");
  const table = page.locator(".clients-table");
  await expect(table.locator("thead th").filter({ hasText: "Phone" })).toBeHidden();
  await expect(table.locator("thead th").filter({ hasText: "Email" })).toBeHidden();
  await expect(table.locator(".clients-phone")).toHaveCount(0);
  await expect(table).not.toContainText("626-555-0101");

  await page.locator(`[data-customer-id="${tenant.customerId}"] .clients-name .customer-detail`).click();
  const profile = page.getByTestId("client-profile-view");
  await expect(profile).toBeVisible();
  await expect(profile).not.toContainText("626-555-0101");
  await expect(profile).not.toContainText("@pawsh-test.example");
  await expect(profile.locator(".profile-facts dt").filter({ hasText: /^(Phone|Email)$/u })).toHaveCount(0);
  // The record still reads as whole: the groomer and client-since rows are there.
  await expect(profile.locator(".profile-facts dt").filter({ hasText: "Client since" })).toBeVisible();

  // The editor offers no contact field and no address or contact section, and its PUT carries none.
  await profile.getByRole("button", { name: "Edit", exact: true }).first().click();
  const editor = page.getByTestId("client-edit-dialog");
  await expect(editor).toBeVisible();
  await expect(editor.locator('[name="phone"], [name="email"]')).toHaveCount(0);
  await expect(editor.getByTestId("client-addresses")).toHaveCount(0);
  await expect(editor.getByTestId("client-address-add")).toHaveCount(0);
  await expect(editor.getByTestId("client-contact-add")).toHaveCount(0);
  const put = page.waitForRequest((outgoing) => outgoing.method() === "PUT" && /\/api\/customers\//u.test(outgoing.url()));
  await editor.getByTestId("client-basic-save").click();
  const sent = await put;
  const body = sent.postDataJSON() as Record<string, unknown>;
  expect("phone" in body || "email" in body || "address" in body).toBe(false);
  // Accepted: a PUT carrying any of them would be refused 403 CONTACT_INFO_FORBIDDEN.
  expect((await sent.response())!.status()).toBe(200);
});

test("with customers.contact_info the same rows are there", async ({ page, request, tenant }) => {
  const member = await createMember(request, `contact+${tenant.runId}@pawsh-test.example`,
    [...permissionPresets.receptionist!]);
  await login(page, member.email, password);
  await openView(page, "nav-customers");
  await expect(page.locator(".clients-table thead th").filter({ hasText: "Phone" })).toBeVisible();
  await expect(page.locator(`[data-customer-id="${tenant.customerId}"] .clients-phone`)).toHaveText("626-555-0101");
});

// ─── F ──────────────────────────────────────────────────────────────────────────────────────

test("calendar card text is drawn at the shared card size", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, tenant.ownerEmail);
  await openView(page, "nav-calendar");
  await revealAppointmentOnCalendar(page, appointment.id);
  const card = page.locator(`.appointment-block[data-appointment-id="${appointment.id}"]`).filter({ visible: true }).first();
  await expect(card.locator(".appointment-time")).toHaveCSS("font-size", "10.5px");
  await expect(card.locator(".service-primary")).toHaveCSS("font-size", "10.5px");
  await expect(card.locator(".appointment-badge")).toHaveCSS("font-size", "9.5px");
});

// ─── Pre-handoff visual round ───────────────────────────────────────────────────────────────

test("@responsive a status reads the same sentence-case words everywhere it is drawn", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  const version = (await (await request.post(`/api/appointments/${appointment.id}/transition`, {
    data: { status: "checked_in", version: appointment.version }
  })).json() as { version: number }).version;
  expect(version).toBeGreaterThan(appointment.version);
  await login(page, tenant.ownerEmail);
  // RENDERED text, so a stylesheet case change is caught as surely as a markup one.
  const rendered = (locator: Locator) => locator.evaluate((node) => (node as HTMLElement).innerText.trim());

  await openDetail(page, appointment.id);
  expect(await rendered(detail(page).getByTestId("appointment-status"))).toBe("Checked in");
  await detail(page).locator("[data-surface-close]").click();

  await page.locator("#calendar-agenda-mode").click();
  const agenda = page.locator(`.agenda-entry[data-appointment-id="${appointment.id}"] .appointment-status`);
  expect(await rendered(agenda)).toBe("Checked in");
  await page.locator("#calendar-calendar-mode").click();

  await openView(page, "nav-customers");
  await page.locator(`[data-customer-id="${tenant.customerId}"] .clients-name .customer-detail`).click();
  const chip = page.getByTestId("client-profile-view").locator(".history-chip.chip-checked_in").first();
  expect(await rendered(chip)).toBe("Checked in");
});

test("the dashboard list reads the same label", async ({ page, request, tenant }) => {
  // The salon's own today, at a fixed early hour - never the wall clock, which can put a visit
  // across local midnight. The fixture groomer works Monday to Friday.
  const zone = "America/Los_Angeles";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(new Date());
  test.skip(weekday === "Sat" || weekday === "Sun", "the fixture groomer does not work today");
  const appointment = await createAppointment(request, tenant, { localStart: `${today}T08:00` });
  const checked = await request.post(`/api/appointments/${appointment.id}/transition`, { data: { status: "checked_in", version: appointment.version } });
  expect(checked.ok(), await checked.text()).toBeTruthy();
  await login(page, tenant.ownerEmail);
  const badge = page.locator(`#today-list [data-appointment-id="${appointment.id}"] .badge`);
  await expect(badge).toBeVisible();
  expect(await badge.evaluate((node) => (node as HTMLElement).innerText.trim())).toBe("Checked in");
});

test("Start service from the card menu keeps the note written before check-in", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T14:00` });
  const noted = await request.patch(`/api/appointments/${appointment.id}/operations`, {
    data: { operationalNotes: "Owner says: nervous about the dryer.", version: appointment.version }
  });
  expect(noted.ok(), await noted.text()).toBeTruthy();
  const afterNote = (await noted.json()) as { version: number };
  const checked = await request.post(`/api/appointments/${appointment.id}/transition`, {
    data: { status: "checked_in", version: afterNote.version }
  });
  expect(checked.ok(), await checked.text()).toBeTruthy();

  const writes: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() === "PATCH" && outgoing.url().endsWith(`/api/appointments/${appointment.id}/operations`)) writes.push(outgoing.url());
  });
  await login(page, tenant.ownerEmail);
  await openView(page, "nav-calendar");
  await revealAppointmentOnCalendar(page, appointment.id);
  await (await appointmentAction(page.locator(`[data-appointment-id="${appointment.id}"]`), "appointment-checked_in")).click();
  await expect(page.getByTestId("field-operationalNotes")).toHaveValue("Owner says: nervous about the dryer.");
  await page.getByTestId("modal-submit").click();
  await expect.poll(async () => (await visit(request, appointment.id)).status).toBe("in_service");
  const after = await visit(request, appointment.id);
  expect(after.operationalNotes).toBe("Owner says: nervous about the dryer.");
  expect(writes).toHaveLength(0);
});

test("Move saved with nothing changed sends no request", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T15:00` });
  const sent: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.url().endsWith(`/api/appointments/${appointment.id}/schedule`)) sent.push(outgoing.method());
  });
  await login(page, tenant.ownerEmail);
  await openView(page, "nav-calendar");
  await revealAppointmentOnCalendar(page, appointment.id);
  const card = page.locator(`[data-appointment-id="${appointment.id}"]`);
  // The card menu's own Move, opened once the grid has settled: a live redraw replaces the menu,
  // so the open is retried rather than pressing an item that was just detached.
  await expect(async () => {
    await page.waitForLoadState("networkidle");
    await card.getByRole("button", { name: /Appointment actions for/u }).filter({ visible: true }).click({ timeout: 2_000 });
    await page.getByRole("menuitem", { name: "Move", exact: true }).filter({ visible: true }).click({ timeout: 2_000 });
    await expect(page.getByTestId("modal")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  expect(sent).toEqual([]);
});

test("a groomer whose landing view is the calendar opens on the selected day, not on Sunday", async ({ page, request, tenant }) => {
  const groomer = await createMember(request, `landing+${tenant.runId}@pawsh-test.example`, [...permissionPresets.groomer!]);
  await login(page, groomer.email, password);
  await expect(page.locator("body")).toHaveAttribute("data-view", "calendar");
  const scroll = page.locator(".week-scroll");
  const selected = await page.evaluate(() => {
    const head = document.querySelector<HTMLElement>(".week-day-head.selected, .week-day-head.today");
    return head ? head.dataset.calendarDate ?? null : null;
  });
  test.skip(!selected, "the selected day is not in this week's grid");
  await expect.poll(async () => scroll.evaluate((node) => {
    const head = node.querySelector<HTMLElement>(".week-day-head.selected, .week-day-head.today")!;
    return head.offsetLeft >= node.scrollLeft && head.offsetLeft + head.offsetWidth <= node.scrollLeft + node.clientWidth + 1;
  })).toBe(true);
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 568 } });
  test("@responsive the visit's utility actions stay on one row", async ({ page, request, tenant }) => {
    const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);
    const utility = detail(page).locator(".surface-foot-utility");
    const tops = await utility.locator("button").evaluateAll((buttons) =>
      [...new Set(buttons.filter((button) => (button as HTMLElement).offsetWidth).map((button) => Math.round(button.getBoundingClientRect().top)))]);
    expect(tops).toHaveLength(1);
  });
});
