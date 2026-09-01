import { expect, login, test } from "./fixtures/tenant.js";
import { chooseBookingClient } from "./helpers/booking.js";

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
  await expect(page.getByTestId("booking-dialog")).toContainText("Create Appointment");
  await chooseBookingClient(page, tenant.customerId);
  await expect(page.locator('#booking-dialog select[name="employeeId"]')).toHaveCount(1);
  await expect(page.locator('#booking-dialog [name="employeeIds"]')).toHaveCount(0);
  await expect(page.getByTestId("booking-dialog")).not.toContainText("Add Another Groomer");
  await page.locator("#booking-dialog .booking-actions .close").click();
  await expect(page.getByTestId("booking-dialog")).toBeHidden();

  await trigger.click();
  await menu.getByRole("menuitem", { name: "Quick Appointment — existing client" }).click();
  await expect(page.getByTestId("booking-client-search")).toBeFocused();
  await page.locator("#booking-dialog .booking-actions .close").click();
  await expect(page.getByTestId("booking-dialog")).toBeHidden();
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

  // The pet profile is its own panel now, not the shared dialog.
  await page.locator(`[data-pet-profile="${tenant.petId}"]`).click();
  const petPanel = page.getByTestId("pet-profile-dialog");
  await expect(petPanel).toBeVisible();
  await expect(page.locator("#pet-profile-title")).toHaveText("Charlie · Pet profile");
  await expect(petPanel.getByTestId("field-breed")).toHaveValue("Golden Retriever");
  await petPanel.getByRole("button", { name: "Close pet profile" }).click();
  await expect(petPanel).toBeHidden();

  // Book New arrives with the client and pet already resolved, so the workspace opens past
  // the client search rather than asking who the booking is for.
  await page.getByRole("button", { name: "Book New" }).click();
  await expect(page.getByTestId("booking-client-name")).toHaveText("Emma Johnson");
  await expect(page.getByTestId("booking-pet-name")).toHaveText("Charlie");
  await expect(page.locator('#booking-dialog [name="petId"]')).toHaveValue(tenant.petId);
  await expect(page.locator('#booking-dialog select[name="employeeId"]')).toHaveValue(tenant.employeeId);
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

  // Availability is the only place working hours are edited, so that grid is where the stored
  // week has to be legible - the Salon team panel that used to carry a second editor is gone.
  await page.getByTestId("nav-settings").click();
  await page.locator("#settings-navigation").getByRole("button", { name: "Availability", exact: true }).click();
  await expect(page.getByTestId("availability-grid")).toBeVisible();
  await expect(page.getByRole("gridcell", { name: /^Grace Groomer, Monday/ })).toContainText("11:15–7:45 PM");
  await expect(page.getByRole("gridcell", { name: /^Grace Groomer, Tuesday/ })).toContainText("Off");
  await expect(page.getByRole("gridcell", { name: /^Grace Groomer, Wednesday/ })).toContainText("7:30–1:15 PM");
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

// The document is the thing being attested to, so it has to be readable before signing and
// afterwards. The name is a button carrying its own affordance rather than plain heading text.
test("local pilot agreement name opens the document and its recorded state", async ({ page, request, tenant }) => {
  const template = await (await request.post("/api/agreement-templates", { data: {
    name: "Cancellation Policy",
    body: "Please give 24 hours notice to cancel or reschedule.",
    required: true
  }})).json() as { id: string };

  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" })
    .getByRole("button", { name: "Emma Johnson" }).click();
  await expect(page.getByTestId("client-profile-view")).toBeVisible();

  const name = page.getByRole("button", { name: "Open Cancellation Policy" });
  await expect(name).toBeVisible();
  await name.click();
  await expect(page.locator("#modal-title")).toHaveText("Cancellation Policy");
  await expect(page.getByTestId("modal")).toContainText("Please give 24 hours notice");
  await expect(page.getByTestId("modal")).toContainText("Not signed");
  await expect(page.getByTestId("modal")).toContainText("Never sent to this client");
  // Pawsh records staff-entered signatures only, and the dialog says so rather than implying
  // a client signing page exists.
  await expect(page.getByTestId("modal")).toContainText("no client signing page");

  // Having read it, the operator can act without reopening the row.
  await page.getByTestId("agreement-detail-action").click();
  await expect(page.locator("#modal-title")).toHaveText("Record a signed agreement");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  await page.getByRole("button", { name: "Open Cancellation Policy" }).click();
  await expect(page.getByTestId("modal")).toContainText("Signed");
  await expect(page.getByTestId("agreement-detail-action")).toHaveText("Correct signature");
  expect((await (await request.get(`/api/customers/${tenant.customerId}/agreements`)).json())
    .items.find((item: { templateId: string }) => item.templateId === template.id).status).toBe("signed");
});
