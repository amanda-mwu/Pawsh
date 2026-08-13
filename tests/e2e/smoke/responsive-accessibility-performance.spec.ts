import { test,expect,login,createAppointment } from "../fixtures/tenant.js";

test("@smoke responsive operational shell remains usable at critical viewports",async({page,tenant})=>{
  for(const viewport of [{width:390,height:844},{width:412,height:915},{width:768,height:1024},{width:1366,height:768}]){
    await page.setViewportSize(viewport);
    if(!await page.getByTestId("dashboard").isVisible())await login(page,tenant.ownerEmail);
    await page.getByTestId("nav-calendar").click();
    await expect(page.getByTestId("calendar")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBeTruthy();
  }
});

test("@smoke critical controls expose keyboard focus, labels, status, and safety semantics",async({page,request,tenant})=>{
  const appointment=await createAppointment(request,tenant,{customerId:tenant.rockyCustomerId,petId:tenant.rockyPetId});
  await login(page,tenant.ownerEmail);
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  await page.getByTestId("nav-calendar").click();
  const row=page.locator(`[data-appointment-id="${appointment.id}"]`);
  await expect(row.getByRole("note",{name:"Pet safety and care information"})).toContainText("Safety alert:");
  await expect(row.locator(".appointment-status")).toContainText("scheduled");
  await page.getByTestId("calendar-add-appointment").click();
  await expect(page.getByTestId("field-customerId")).toHaveAccessibleName("Customer");
  await expect(page.getByTestId("modal-submit")).toHaveAccessibleName("Save");
});

test("@smoke primary browser reads remain within generous QA regression budgets",async({page,tenant})=>{
  const started=Date.now();
  await login(page,tenant.ownerEmail);
  expect(Date.now()-started).toBeLessThan(4_000);
  const calendarStart=Date.now();
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar-list")).toBeVisible();
  expect(Date.now()-calendarStart).toBeLessThan(3_000);
  const searchStart=Date.now();
  await page.getByTestId("nav-customers").click();
  await page.getByTestId("customer-search").fill("Emma");
  await expect(page.getByTestId("customer-card")).toHaveCount(1);
  await expect(page.getByTestId("customer-card")).toContainText("Emma Johnson");
  expect(Date.now()-searchStart).toBeLessThan(2_000);
});
