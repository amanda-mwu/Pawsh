import { test, expect, login, createAppointment } from "./fixtures/tenant.js";
import type { TenantFixture } from "./fixtures/tenant.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * Messages → the client context rail.
 *
 * The rail renders the client profile's own summary column, but not the same tabs: Preference
 * belongs to the full profile, while Appointments and Cards belong beside a conversation. One tab
 * registry drives both surfaces, so these specs assert the two selections stay distinct and that
 * the single `tab` field backing them never leaks one surface's selection into the other.
 *
 * Nothing here is mocked. The counts come from `/api/customers/:id/history`, whose upcoming
 * preview caps at 25 rows and whose history preview caps at 5, so the truncation strip is
 * exercised against real server totals rather than a stubbed payload.
 */

const anchorAt = (tenant: TenantFixture, dayOffset: number, utcHour: number): string =>
  new Date(new Date(tenant.anchor).getTime() + dayOffset * 86_400_000 + utcHour * 3_600_000)
    .toISOString();

async function transition(
  request: APIRequestContext,
  id: string,
  status: string,
  version: number
): Promise<void> {
  const response = await request.post(`/api/appointments/${id}/transition`, {
    data: { status, version }
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** Open Messages, select one client's conversation, and return the context rail. */
async function openConversation(page: Page, name: string): Promise<Locator> {
  await page.getByTestId("nav-messages").click();
  await page.locator("[data-message-client]").filter({ hasText: name }).click();
  const rail = page.locator("#message-client-context");
  await expect(rail.getByTestId("client-tabs")).toBeVisible();
  return rail;
}

test("the messages rail offers Pets, Appointments and Cards rather than the profile's tabs", async ({
  page,
  tenant
}) => {
  await login(page, tenant.ownerEmail);
  // Sophia owns two pets and no appointments, so both appointment sections show their empty state
  // in one view — the fact the stacked layout exists to surface.
  const rail = await openConversation(page, "Sophia Chen");

  await expect(rail.getByRole("tab")).toHaveText(["Pets", "Appointments", "Cards"]);
  await expect(rail.getByTestId("client-tab-preference")).toHaveCount(0);
  await expect(rail.getByTestId("client-tab-pets")).toHaveAttribute("aria-selected", "true");
  await expect(rail.getByTestId("client-panel-pets")).toBeVisible();
  await expect(rail.getByTestId("client-panel-pets")).toContainText("Mochi");
  await expect(rail.getByTestId("client-panel-appointments")).toBeHidden();

  // Selecting a tab re-renders the column and destroys the clicked button, so focus has to be
  // restored deliberately. It used to fall to <body>.
  await rail.getByTestId("client-tab-appointments").click();
  await expect(rail.getByTestId("client-tab-appointments")).toHaveAttribute("aria-selected", "true");
  await expect(rail.getByTestId("client-tab-appointments")).toBeFocused();
  await expect(rail.getByTestId("client-panel-appointments")).toBeVisible();
  await expect(rail.getByTestId("client-panel-pets")).toBeHidden();

  const panel = rail.getByTestId("client-panel-appointments");
  await expect(panel).toContainText("Upcoming (0)");
  await expect(panel).toContainText("History (0)");
  await expect(rail.getByTestId("client-upcoming-empty")).toBeVisible();
  await expect(rail.getByTestId("client-past-empty")).toBeVisible();
  await expect(rail.getByTestId("client-appointment-row")).toHaveCount(0);
  // Nothing is truncated when nothing exists.
  await expect(rail.getByTestId("client-upcoming-more")).toHaveCount(0);
  await expect(rail.getByTestId("client-past-more")).toHaveCount(0);

  // Arrow keys keep the existing automatic activation: one keypress selects and focuses.
  await rail.getByTestId("client-tab-appointments").press("ArrowRight");
  await expect(rail.getByTestId("client-tab-cards")).toHaveAttribute("aria-selected", "true");
  await expect(rail.getByTestId("client-tab-cards")).toBeFocused();

  const cards = rail.getByTestId("client-cards-placeholder");
  await expect(cards).toBeVisible();
  await expect(cards).toContainText("Not available yet");
  await expect(cards).toContainText("Card on file");
  await expect(cards).toContainText("Pawsh does not store card details for a client");
  await expect(cards).toContainText("Square Terminal");
  // Pawsh stores no card token and has nowhere to add one, so the panel must not imply otherwise:
  // no add-card affordance, enabled or disabled, and no empty card slot.
  await expect(cards.getByRole("button")).toHaveCount(0);
  await expect(cards).not.toContainText("Coming soon");
  await expect(cards).not.toContainText("Add card");
});

test("the rail's appointment sections report honest totals and hand paging to the profile", async ({
  page,
  request,
  tenant
}) => {
  // Two appointments still ahead and six settled. "Past" is anything not still ahead, so a
  // cancelled future booking counts as history — the cheap way to exceed the five-row preview.
  const scheduled = await createAppointment(request, tenant, { startAt: anchorAt(tenant, 1, 17) });
  const checkedIn = await createAppointment(request, tenant, { startAt: anchorAt(tenant, 1, 20) });
  await transition(request, checkedIn.id, "checked_in", checkedIn.version);
  const settledSlots: [number, number][] = [[2, 17], [2, 20], [3, 17], [3, 20], [4, 17], [4, 20]];
  for (const [dayOffset, utcHour] of settledSlots) {
    const settled = await createAppointment(request, tenant, {
      startAt: anchorAt(tenant, dayOffset, utcHour)
    });
    await transition(request, settled.id, "cancelled", settled.version);
  }

  await login(page, tenant.ownerEmail);
  const rail = await openConversation(page, "Emma Johnson");
  await rail.getByTestId("client-tab-appointments").click();

  const panel = rail.getByTestId("client-panel-appointments");
  const upcomingRows = rail.getByTestId("client-upcoming-list").getByTestId("client-appointment-row");
  const pastRows = rail.getByTestId("client-past-list").getByTestId("client-appointment-row");

  await expect(panel).toContainText("Upcoming (2)");
  await expect(panel).toContainText("History (6)");
  await expect(upcomingRows).toHaveCount(2);
  // The history preview caps at five rows server-side, and the count says so rather than
  // presenting five as the whole story.
  await expect(pastRows).toHaveCount(5);
  await expect(rail.getByTestId("client-past-more")).toContainText("Showing 5 of 6 past");
  // Truncation is computed per half, so the untruncated half carries no strip.
  await expect(rail.getByTestId("client-upcoming-more")).toHaveCount(0);

  // Rows carry the pet, the groomer and the services — and no price. The rail cannot know an
  // appointment's payment state, so it claims nothing about it.
  await expect(upcomingRows.first()).toContainText("Charlie");
  await expect(upcomingRows.first()).toContainText("Grace Groomer");
  await expect(upcomingRows.first()).toContainText("Full Groom");
  await expect(panel).not.toContainText("$85");

  // Every upcoming appointment is scheduled, so a "scheduled" chip on every row would be
  // decoration. One that has moved on is worth showing, and history always carries its outcome.
  await expect(panel.locator(".history-chip", { hasText: "scheduled" })).toHaveCount(0);
  await expect(panel.locator(".history-chip", { hasText: "checked in" })).toHaveCount(1);
  await expect(pastRows.locator(".history-chip.chip-cancelled")).toHaveCount(5);

  // The rows are bound in the shared summary binder, not in renderClientProfile(), which returns
  // early in Messages. Before that move they were inert here.
  await upcomingRows.first().click();
  const detail = page.getByTestId("appointment-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(String(scheduled.id).slice(0, 8));
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  // The truncation strip emits its own "Open full profile" button. Only the first copy on the pane
  // used to be bound, so this is the one that proves the rest are too.
  await rail
    .getByTestId("client-past-more")
    .getByRole("button", { name: "Open full profile" })
    .click();
  await expect(page.getByTestId("client-profile-view")).toBeVisible();

  // The profile has no Appointments tab, so the shared field falls back for this render only.
  const column = page.locator("#client-profile-content .client-profile-left");
  await expect(column.getByRole("tab")).toHaveText(["Pets", "Preference"]);
  await expect(column.getByTestId("client-tab-pets")).toHaveAttribute("aria-selected", "true");
  // The profile's history table is untouched and still carries the price column the rail drops.
  await expect(page.locator(".client-profile-right .history-table").first()).toContainText(
    "Total Sales"
  );

  // Back in the conversation, Appointments is still selected: the fallback was render-local and
  // was never written back to the shared field.
  await page.locator(".client-profile-back").click();
  await expect(page.locator("#messages")).toBeVisible();
  await expect(rail.getByTestId("client-tab-appointments")).toHaveAttribute(
    "aria-selected",
    "true"
  );
});

test("the client profile keeps Pets and Preference and gains neither new tab", async ({
  page,
  tenant
}) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await page
    .getByTestId("customer-card")
    .filter({ hasText: "Emma Johnson" })
    .getByRole("button", { name: "Emma Johnson" })
    .click();
  await expect(page.getByTestId("client-profile-view")).toBeVisible();

  const column = page.locator("#client-profile-content .client-profile-left");
  await expect(column.getByRole("tab")).toHaveText(["Pets", "Preference"]);
  await expect(column.getByTestId("client-tab-appointments")).toHaveCount(0);
  await expect(column.getByTestId("client-tab-cards")).toHaveCount(0);
  await expect(column.getByTestId("client-panel-pets")).toContainText("Charlie");

  await column.getByTestId("client-tab-preference").click();
  await expect(column.getByTestId("client-tab-preference")).toHaveAttribute("aria-selected", "true");
  await expect(column.getByTestId("client-tab-preference")).toBeFocused();
  await expect(column.getByTestId("client-panel-preference")).toContainText("Booking frequency");
  await expect(column.getByTestId("client-panel-preference")).toContainText("Mark inactive");
  await expect(column.getByTestId("client-panel-pets")).toBeHidden();
});
