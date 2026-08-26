import {
  test,
  expect,
  login,
  createAppointment,
  completeAppointment,
  appointmentAction
} from "./fixtures/tenant.js";
import { decodablePng } from "../support/images.js";

async function advance(
  request: Parameters<typeof createAppointment>[0],
  appointment: { id: string; version: number },
  statuses: Array<"checked_in" | "in_service" | "completed">
) {
  let version = appointment.version;
  for (const status of statuses) {
    const response = await request.post(`/api/appointments/${appointment.id}/transition`, {
      data: { status, version }
    });
    expect(response.status()).toBe(200);
    version = (await response.json()).version;
  }
  return { ...appointment, version };
}

test("@regression-lifecycle completes the primary lifecycle with persisted UI state", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  let row = page.locator(`[data-appointment-id="${appointment.id}"]`);

  await (await appointmentAction(row,"appointment-scheduled")).click();
  await page.getByTestId("modal-submit").click();
  await expect(row).toContainText("checked in");

  await page.reload();
  await page.getByTestId("nav-calendar").click();
  row = page.locator(`[data-appointment-id="${appointment.id}"]`);
  await (await appointmentAction(row,"appointment-checked_in")).click();
  await page.getByTestId("field-operationalNotes").fill("D2 lifecycle service notes");
  await page.getByTestId("modal-submit").click();
  await expect(row).toContainText("in service");

  page.once("dialog", (dialog) => dialog.accept());
  await (await appointmentAction(row,"appointment-in_service")).click();
  await expect(row).toContainText("completed");
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  row = page.locator(`[data-appointment-id="${appointment.id}"]`);
  await expect(row).toContainText("completed");
  await expect(row.getByTestId("appointment-scheduled")).toHaveCount(0);
  await expect(row.getByTestId("appointment-checked_in")).toHaveCount(0);
  await expect(row.getByTestId("appointment-in_service")).toHaveCount(0);
});

test("@regression-lifecycle keeps completed and no-show terminal controls coherent", async ({ page, request, tenant }) => {
  const completed = await completeAppointment(request, tenant);
  const noShow = await createAppointment(request, tenant, {
    localStart: `${tenant.anchor}T11:00`
  });
  const noShowResponse = await request.post(`/api/appointments/${noShow.id}/transition`, {
    data: { status: "no_show", version: noShow.version }
  });
  expect(noShowResponse.status()).toBe(200);

  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  for (const [id, status] of [[completed.id, "completed"], [noShow.id, "no show"]] as const) {
    const row = page.locator(`[data-appointment-id="${id}"]`);
    await expect(row).toContainText(status);
    await expect(row.getByTestId("appointment-scheduled")).toHaveCount(0);
    await expect(row.getByTestId("appointment-checked_in")).toHaveCount(0);
    await expect(row.getByTestId("appointment-in_service")).toHaveCount(0);
    await expect(row.locator(".terminal-action")).toHaveCount(0);
  }
});

test("@regression-lifecycle disables duplicate completion and sends one transition", async ({ page, request, tenant }) => {
  const created = await createAppointment(request, tenant);
  const appointment = await advance(request, created, ["checked_in", "in_service"]);
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  const row = page.locator(`[data-appointment-id="${appointment.id}"]`);
  const complete = await appointmentAction(row,"appointment-in_service");

  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let transitionRequests = 0;
  await page.route(`**/api/appointments/${appointment.id}/transition`, async (route) => {
    transitionRequests += 1;
    await released;
    await route.continue();
  });
  page.once("dialog", (dialog) => dialog.accept());
  await complete.click();
  await expect(complete).toBeDisabled();
  await expect(complete).toHaveAttribute("aria-busy", "true");
  release();
  await expect(row).toContainText("completed");
  expect(transitionRequests).toBe(1);
});

test("@regression-lifecycle reconciles a stale visible action to authoritative state", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  let row = page.locator(`[data-appointment-id="${appointment.id}"]`);
  await (await appointmentAction(row,"appointment-scheduled")).click();
  await expect(page.getByTestId("modal")).toBeVisible();

  const advanced = await request.post(`/api/appointments/${appointment.id}/transition`, {
    data: { status: "checked_in", version: appointment.version }
  });
  expect(advanced.status()).toBe(200);

  const staleResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/appointments/${appointment.id}/transition`)
      && response.request().method() === "POST"
  );
  await page.getByTestId("modal-submit").click();
  expect((await staleResponse).status()).toBe(409);
  await expect(page.locator("#modal-error")).toContainText("changed");
  await page.getByTestId("modal").getByLabel("Close").click();

  row = page.locator(`[data-appointment-id="${appointment.id}"]`);
  await expect(row).toContainText("checked in");
  await expect(row.getByTestId("appointment-scheduled")).toHaveCount(0);
  await expect(await appointmentAction(row,"appointment-checked_in")).toBeVisible();
});

// The activity feed is read from the audit trail, so it reports what was actually recorded and
// by whom rather than being reconstructed from the appointment's current state.
test("@regression-lifecycle appointment detail reports its reference, billing state, and audited activity", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  let version = appointment.version;
  for (const status of ["checked_in", "in_service", "completed"]) {
    const moved = await request.post(`/api/appointments/${appointment.id}/transition`, { data: { status, version } });
    expect(moved.status(), status).toBe(200);
    version = (await moved.json()).version;
  }
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.locator(`[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();
  const detail = page.getByTestId("appointment-detail");
  await expect(detail).toBeVisible();

  await expect(page.getByTestId("appointment-reference"))
    .toContainText(`Appointment #${appointment.id.slice(0, 8)}`);
  // Completed but never checked out: unbilled reads differently from unpaid, and the chip says so.
  await expect(page.getByTestId("appointment-billing")).toHaveText("Not invoiced");

  const activity = page.getByTestId("appointment-activity");
  await expect(activity).not.toHaveAttribute("open", "");
  await expect(activity.locator("[data-activity-count]")).toHaveText(/^\(\d+\)$/);
  await activity.locator("summary").click();
  await expect(activity).toHaveAttribute("open", "");
  const feed = activity.locator(".activity-feed li");
  await expect(feed.filter({ hasText: "Appointment created" })).toHaveCount(1);
  await expect(feed.filter({ hasText: "Checked in" })).toHaveCount(1);
  await expect(feed.filter({ hasText: "Marked completed" })).toHaveCount(1);
  // Every line is attributable. The owner has no employee record here, so the feed falls back to
  // their account identity rather than leaving the entry unattributed.
  await expect(feed.first()).toContainText(tenant.ownerEmail.split("@")[0]!);
  await expect(activity).not.toContainText("an unknown account");

  // Check-in and check-out are derived from those audited moments, not from stored columns.
  await expect(page.getByTestId("appointment-lifecycle")).toContainText("Checked in:");
  await expect(page.getByTestId("appointment-lifecycle")).not.toContainText("Checked in: not recorded");
});

// Photos are a real upload through the browser: what gets stored is what the bytes parse as,
// and what comes back renders in an <img> from the same origin.
test("@regression-lifecycle appointment photos upload, render, and delete", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.locator(`[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();
  const photos = page.getByTestId("appointment-photos");
  await expect(photos).toBeVisible();
  await expect(photos.locator(".photo-pet summary")).toContainText("Charlie");

  const chooser = page.waitForEvent("filechooser");
  await photos.locator('.photo-add[data-photo-phase="before"]').click();
  await (await chooser).setFiles({
    name: "charlie-before.png", mimeType: "image/png", buffer: decodablePng(640, 480)
  });

  const tile = photos.locator('.photo-phase', { hasText: "Before" }).locator(".photo-tile");
  await expect(tile).toHaveCount(1);
  const image = tile.locator("img");
  await expect(image).toHaveAttribute("src", /\/api\/appointment-photos\/[0-9a-f-]+\/content$/);
  // The browser actually decoded it; a broken response would leave naturalWidth at 0.
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(640);

  page.once("dialog", (dialog) => dialog.accept());
  await tile.locator(".photo-remove").click();
  await expect(tile).toHaveCount(0);
});

// The card is created, previewed in its own window, sent, and deleted — the four actions the
// row offers. The preview is a staff page: it needs the session, and there is no link to give
// a client.
test("@regression-lifecycle report card is created, previewed in a new window, sent, and deleted", async ({ page, context, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.locator(`[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();

  const cards = page.getByTestId("appointment-report-cards");
  await expect(cards).toContainText("No report card for this visit yet");

  await page.getByTestId("report-card-add").click();
  await page.locator('#stacked-dialog [name="note"]').fill("Charlie was very well behaved.");
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(cards.locator("tbody tr")).toHaveCount(1);
  await expect(cards).toContainText("Charlie");
  // Never sent says so; a blank cell could be read either way.
  await expect(cards).toContainText("Not sent");

  const preview = context.waitForEvent("page");
  await cards.getByRole("button", { name: "Preview report card" }).click();
  const previewPage = await preview;
  await previewPage.waitForLoadState();
  await expect(previewPage).toHaveTitle(/Charlie/);
  await expect(previewPage.locator("h1")).toHaveText("Charlie");
  await expect(previewPage.locator("body")).toContainText("Charlie was very well behaved.");
  await expect(previewPage.locator("body")).toContainText("Full Groom");
  await expect(previewPage.locator("body")).toContainText("not yet sent");
  await previewPage.close();

  await cards.getByRole("button", { name: "Send report card" }).click();
  // The limitation is stated before anyone presses send, not discovered afterwards.
  await expect(page.getByTestId("stacked-dialog")).toContainText("does not carry the photos");
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(cards).not.toContainText("Not sent");

  page.once("dialog", (dialog) => dialog.accept());
  await cards.getByRole("button", { name: "Delete report card" }).click();
  await expect(cards).toContainText("No report card for this visit yet");
});
