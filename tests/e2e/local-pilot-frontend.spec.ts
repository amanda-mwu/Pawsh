import { expect, login, test } from "./fixtures/tenant.js";

test("local pilot + New menu is compact, honest, keyboard accessible, and canonical", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  const trigger = page.getByTestId("new-action-trigger");
  const menu = page.getByTestId("new-action-menu");
  await expect(trigger).toHaveText("+ New");
  await expect(trigger.locator("[aria-hidden]")).toHaveCount(0);
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const labels = (await menu.getByRole("menuitem").allTextContents()).map(label => label.replace(/Coming soon/g, "").trim());
  expect(labels).toEqual([
    "New Appointment", "Quick Appointment — new client", "Quick Appointment — existing client", "New Block Time",
    "New Sale", "Sale Gift Card", "Activate Gift Card", "New Expense Record"
  ]);
  for (const label of ["Quick Appointment — new client", "New Sale", "Sale Gift Card", "Activate Gift Card", "New Expense Record"]) {
    await expect(menu.getByRole("menuitem", { name: new RegExp(label) })).toBeDisabled();
  }

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "New Appointment" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("modal")).toContainText("New appointment");
  await expect(page.locator('#modal select[name="employeeId"]')).toHaveCount(1);
  await expect(page.locator('#modal [name="employeeIds"]')).toHaveCount(0);
  await expect(page.getByTestId("modal")).not.toContainText("Add Another Groomer");
  await page.locator("#modal .modal-actions .close").click();

  await trigger.click();
  await menu.getByRole("menuitem", { name: "Quick Appointment — existing client" }).click();
  await expect(page.locator('#modal select[name="customerId"]')).toBeFocused();
  await page.locator("#modal .modal-actions .close").click();
  await trigger.click();
  await menu.getByRole("menuitem", { name: "New Block Time" }).click();
  await expect(page.getByTestId("modal")).toContainText("Block team time");
  await page.locator("#modal .modal-actions .close").click();

  await trigger.click();
  await page.getByTestId("dashboard").click({ position: { x: 5, y: 5 } });
  await expect(menu).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

test("local pilot client profile, pet profile, preferred groomer, and Book New", async ({ page, request, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  const client = page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" });
  await client.getByRole("button", { name: "Emma Johnson" }).click();

  await expect(page.getByTestId("client-profile-view")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Emma Johnson" })).toBeVisible();
  await page.getByRole("button", { name: "Not set" }).click();
  await page.locator('#modal select[name="employeeId"]').selectOption(tenant.employeeId);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByRole("button", { name: "Grace Groomer" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Grace Groomer" })).toBeVisible();
  expect((await (await request.get(`/api/customers/${tenant.customerId}/history`)).json()).customer.preferredEmployeeId)
    .toBe(tenant.employeeId);

  await page.locator(`[data-pet-profile="${tenant.petId}"]`).click();
  await expect(page.getByTestId("modal")).toContainText("Charlie · Pet Profile");
  await expect(page.getByTestId("modal")).toContainText("Golden Retriever");
  await page.locator("#modal .modal-actions .close").click();

  await page.getByRole("button", { name: "Book New" }).click();
  await expect(page.locator('#modal select[name="customerId"]')).toHaveValue(tenant.customerId);
  await expect(page.locator('#modal select[name="petId"]')).toHaveValue(tenant.petId);
  await expect(page.locator('#modal select[name="employeeId"]')).toHaveValue(tenant.employeeId);
});

test("local pilot reminders expose supported and deferred tabs honestly", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-reminders").click();
  await expect(page.getByRole("tab")).toHaveCount(6);
  await expect(page.getByRole("tab", { name: "Appointment Reminder" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".reminder-table")).toBeVisible();

  await page.getByRole("tab", { name: "Vaccination Reminder" }).click();
  await expect(page.locator(".reminder-table")).toBeVisible();
  for (const name of ["Secondary Reminder", "Same-Day Reminder", "Rebook Reminder", "Pet Birthday Reminder"]) {
    await page.getByRole("tab", { name }).click();
    await expect(page.locator(".reminder-empty")).toContainText("no Pawsh scheduling or delivery backend yet");
  }
});

test("local pilot calendar sends employeeIds and employee hours round-trip unchanged", async ({ page, request, tenant }) => {
  const secondEmployee = await (await request.post("/api/employees", {
    data: { displayName: "Alex Groomer", serviceIds: [tenant.serviceId] }
  })).json() as { id: string };
  expect(secondEmployee.id).toBeTruthy();
  const unusualHours = [
    { weekday: 1, startTime: "11:15", endTime: "19:45" },
    { weekday: 3, startTime: "07:30", endTime: "13:15" },
  ];
  expect((await request.put(`/api/employees/${tenant.employeeId}/working-hours`, { data: { hours: unusualHours } })).status()).toBe(204);
  await login(page, tenant.ownerEmail);

  await page.getByTestId("nav-calendar").click();
  await page.locator("#groomer-filter summary").click();
  await page.getByRole("button", { name: "Deselect All" }).click();
  await page.locator(`#groomer-filter-options input[value="${tenant.employeeId}"]`).check();
  const filtered = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/appointments" && url.searchParams.get("employeeIds") === tenant.employeeId;
  });
  await page.getByRole("button", { name: "Apply" }).click();
  expect((await filtered).status()).toBe(200);

  await page.getByTestId("nav-setup").click();
  await page.locator("#employee-list > div").filter({ hasText: "Grace Groomer" }).getByRole("button", { name: "Edit" }).click();
  await expect(page.locator('#modal input[name="day1"]')).toBeChecked();
  await expect(page.locator('#modal input[name="start1"]')).toHaveValue("11:15");
  await expect(page.locator('#modal input[name="end1"]')).toHaveValue("19:45");
  await expect(page.locator('#modal input[name="day2"]')).not.toBeChecked();
  await expect(page.locator('#modal input[name="day3"]')).toBeChecked();
  await page.getByTestId("modal-submit").click();
  expect(await (await request.get(`/api/employees/${tenant.employeeId}/working-hours`)).json()).toEqual(unusualHours);
});

test("local pilot Charts and Report share authoritative totals and groomer query", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-reports").click();
  const reportsResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/reports" && url.searchParams.get("employeeIds") === tenant.employeeId;
  });
  await page.locator("#report-groomers").selectOption(tenant.employeeId);
  await page.getByRole("button", { name: "Apply" }).click();
  expect((await reportsResponse).status()).toBe(200);

  const chartTotals = await page.locator("#report-summary .metric strong").allTextContents();
  await page.locator("#report-table-mode").click();
  await expect(page.locator("#report-table")).toBeVisible();
  expect(await page.locator("#report-table-body tr td:last-child").allTextContents()).toEqual(chartTotals);
});
