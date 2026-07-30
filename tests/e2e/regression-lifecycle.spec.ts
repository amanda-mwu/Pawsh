import {
  test,
  expect,
  login,
  createAppointment,
  completeAppointment
} from "./fixtures/tenant.js";

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

  await row.getByTestId("appointment-scheduled").click();
  await page.getByTestId("modal-submit").click();
  await expect(row).toContainText("checked in");

  await page.reload();
  await page.getByTestId("nav-calendar").click();
  row = page.locator(`[data-appointment-id="${appointment.id}"]`);
  await row.getByTestId("appointment-checked_in").click();
  await page.getByTestId("field-operationalNotes").fill("D2 lifecycle service notes");
  await page.getByTestId("modal-submit").click();
  await expect(row).toContainText("in service");

  page.once("dialog", (dialog) => dialog.accept());
  await row.getByTestId("appointment-in_service").click();
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
    startAt: new Date(new Date(tenant.anchor).getTime() + 86_400_000 + 17 * 3_600_000).toISOString()
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
  const complete = row.getByTestId("appointment-in_service");

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
  await row.getByTestId("appointment-scheduled").click();
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

  row = page.locator(`[data-appointment-id="${appointment.id}"]`);
  await expect(row).toContainText("checked in");
  await expect(row.getByTestId("appointment-scheduled")).toHaveCount(0);
  await expect(row.getByTestId("appointment-checked_in")).toBeVisible();
});
