import { test, expect, login } from "../fixtures/tenant.js";

test("@smoke CRM search persists and booking filters pets by customer",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await page.getByTestId("new-customer").click();
  await page.getByTestId("field-firstName").fill("Smoke");
  await page.getByTestId("field-lastName").fill("Searchable");
  await page.getByTestId("field-email").fill(`search+${tenant.runId}@pawsh-test.example`);
  await page.getByTestId("field-phone").fill("626-555-0199");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await page.getByTestId("customer-search").fill("6265550199");
  await expect(page.getByTestId("customer-card")).toHaveCount(1);
  await expect(page.getByTestId("customer-card")).toContainText("Smoke Searchable");
  await page.getByTestId("customer-search").fill(`search+${tenant.runId}`);
  await expect(page.getByTestId("customer-card")).toHaveCount(1);
  await expect(page.getByTestId("customer-card")).toContainText("Smoke Searchable");
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await page.getByTestId("calendar-add-appointment").click();
  await page.getByTestId("field-customerId").selectOption(tenant.sophiaCustomerId);
  await expect(page.getByTestId("field-petId").locator("option",{hasText:"Mochi"})).toHaveCount(1);
  await expect(page.getByTestId("field-petId").locator("option",{hasText:"Boba"})).toHaveCount(1);
  await expect(page.getByTestId("field-petId").locator(`option[value="${tenant.petId}"]`)).toHaveCount(0);
});

test("@smoke scheduling rejects overlap and blocked time but permits adjacency",async({page,request,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  const createAt=async(time:string)=>{
    await page.getByTestId("calendar-add-appointment").click();
    await page.getByTestId("field-customerId").selectOption(tenant.customerId);
    const defaults=page.waitForResponse(response=>response.url().includes(`/api/pets/${tenant.petId}/booking-defaults`));
    await page.getByTestId("field-petId").selectOption(tenant.petId);
    await defaults;
    await page.locator(`input[name="employeeIds"][value="${tenant.employeeId}"]`).setChecked(true);
    await page.getByLabel("Full Groom").setChecked(true);
    await page.getByTestId("field-startAt").fill(`${tenant.anchor}T${time}`);
    await page.getByTestId("modal-submit").click();
  };
  await createAt("09:00");
  await expect(page.getByTestId("calendar-list")).toContainText("Charlie");
  await createAt("09:30");
  await expect(page.locator("#modal-error")).toContainText("overlapping appointment");
  await page.getByTestId("modal").getByRole("button",{name:"Cancel"}).click();
  await createAt("10:30");
  await expect(page.getByTestId("calendar-list").getByText("Charlie")).toHaveCount(2);
  await request.post("/api/blocked-times",{data:{
    employeeId:tenant.employeeId,locationId:tenant.locationId,localStart:`${tenant.anchor}T13:00`,
    localEnd:`${tenant.anchor}T14:00`,expectedLocationVersion:tenant.locationVersion,reason:"Smoke blocked time"
  }});
  await createAt("13:00");
  await expect(page.locator("#modal-error")).toContainText("explicit override");
});
