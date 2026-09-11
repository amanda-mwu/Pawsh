import { test, expect, login, createAppointment } from "./fixtures/tenant.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * WHAT A COUNTER DOES WITH A PET THAT IS IN THE SALON.
 *
 * Three things, and they are three different questions: record what happened (Save), say the work
 * is finished (Ready for Pickup), and take the money (Take Payment). None of them implies another.
 * A visit may be paid for at drop-off and handed back an hour later; it may be handed back and
 * settled next week; the note may be corrected after both.
 *
 * WHY THIS IS A BROWSER SPEC. What the footer DRAWS is held deterministically in
 * `tests/ui/checkout-eligibility.test.ts`, which runs the real `derive()` and the real markup.
 * Three things cannot be asserted there and are the reason this walk exists:
 *
 *   SAVE WAKES AND SLEEPS. Dirtiness is a comparison made against a live textarea as somebody
 *       types into it; jsdom can see the initial `disabled` attribute and nothing after it.
 *   THE SERVER KEEPS WHAT WAS SAVED, and it is read back off the API rather than off the screen.
 *   A REFUSED SAVE LOSES NOTHING. The claim is about text still being in a control after a
 *       request failed, which only a real page can hold.
 *
 * NOT IN SCOPE and deliberately untouched: the checkout workspace, client credit, and the
 * document rules. This walk presses the footer.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");
const save = (page: Page): Locator => detail(page).getByTestId("appointment-save");
const ready = (page: Page): Locator => detail(page).getByTestId("appointment-ready");
const noteField = (page: Page): Locator => detail(page).getByTestId("appointment-note-input");

async function checkInAppointment(api: APIRequestContext, tenant: { locationId: string }) {
  const appointment = await createAppointment(api, tenant as never);
  const response = await api.post(`/api/appointments/${appointment.id}/transition`, {
    data: { status: "checked_in", version: appointment.version }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { ...appointment, version: ((await response.json()) as { version: number }).version };
}

/** What the server says about the visit, which is the only authority on any of it. */
async function visit(api: APIRequestContext, appointmentId: string): Promise<{
  status: string; operationalNotes: string | null; invoiceId: string | null;
}> {
  const response = await api.get(`/api/appointments/${appointmentId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as {
    status: string; operationalNotes: string | null; invoiceId: string | null;
  };
  return {
    status: payload.status, operationalNotes: payload.operationalNotes,
    invoiceId: payload.invoiceId ?? null
  };
}

async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

test("Save sleeps until something is actually changed, and goes back to sleep once it is saved",
  async ({ page, request, tenant }) => {
    const appointment = await checkInAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    // NOTHING HAS BEEN CHANGED, so there is nothing to save. Disabled rather than absent: the
    // control is the operator's, and a footer whose buttons appear as one types moves under the
    // pointer.
    await expect(save(page)).toBeDisabled();
    await expect(save(page)).toHaveAttribute("aria-disabled", "true");

    await noteField(page).fill("Matted behind both ears; clipped short with the owner's say-so.");
    await expect(save(page)).toBeEnabled();

    // TYPED AND UNTYPED IS NOT AN EDIT. A flag set on the first keystroke could not tell the
    // difference; a comparison against what was loaded can.
    await noteField(page).fill("");
    await expect(save(page)).toBeDisabled();

    await noteField(page).fill("Matted behind both ears; clipped short with the owner's say-so.");
    await expect(save(page)).toBeEnabled();
    await save(page).click();

    // The server kept it, and the footer has nothing left to offer.
    await expect(save(page)).toBeDisabled();
    expect((await visit(request, appointment.id)).operationalNotes)
      .toBe("Matted behind both ears; clipped short with the owner's say-so.");
  });

test("a refused Save keeps the operator's words on the screen",
  async ({ page, request, tenant }) => {
    const appointment = await checkInAppointment(request, tenant);
    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);

    // Somebody else writes to the appointment while this surface is open, so the version this
    // page is holding goes stale and the save it is about to send will be refused.
    const edited = await request.patch(`/api/appointments/${appointment.id}`, {
      data: { notes: "Owner rang about the ears" }
    });
    expect(edited.ok(), await edited.text()).toBeTruthy();

    const typed = "Nails done, ears flushed, second bath needed next time.";
    await noteField(page).fill(typed);
    await expect(save(page)).toBeEnabled();
    await save(page).click();

    // NOTHING REDRAWS ON A REFUSAL, which is the whole point of not having written it anywhere
    // else: the words are still in the box and Save is pressable again so it can be tried.
    await expect(noteField(page)).toHaveValue(typed);
    await expect(save(page)).toBeEnabled();
    // And the server has none of it.
    expect((await visit(request, appointment.id)).operationalNotes).toBeNull();
  });

test("Ready for Pickup finishes the work and touches no money at all",
  async ({ page, request, tenant }) => {
    const appointment = await checkInAppointment(request, tenant);
    await login(page, tenant.ownerEmail);

    // Every request this page makes that could raise a bill or record a tender. The assertion is
    // that there were none: finishing the work is not a financial act.
    const money: string[] = [];
    page.on("request", (outgoing) => {
      if (outgoing.method() !== "POST") return;
      const path = new URL(outgoing.url()).pathname;
      if (/\/checkout$/u.test(path) || /\/payments$/u.test(path)) money.push(path);
    });

    await openDetail(page, appointment.id);
    await expect(ready(page)).toBeVisible();
    // Secondary, always: money outranks it, and there is exactly one primary on this footer.
    await expect(ready(page)).toHaveClass(/secondary/u);
    await expect(detail(page).locator("footer .primary")).toHaveCount(1);

    await ready(page).click();

    // THE SERVER'S ANSWER, which is the only one that counts. `completed` is the existing status:
    // no new state was invented for this button.
    await expect(async () => {
      expect((await visit(request, appointment.id)).status).toBe("completed");
    }).toPass();
    expect(money).toEqual([]);
    expect((await visit(request, appointment.id)).invoiceId).toBeNull();

    // And the button is gone from the visit it has already finished.
    await expect(ready(page)).toHaveCount(0);
  });
