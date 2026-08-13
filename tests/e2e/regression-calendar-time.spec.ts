import { createAppointment, expect, login, test } from "./fixtures/tenant.js";

test("@regression-calendar-time keeps Los Angeles scheduling intent in a New York browser", async ({browser,request,tenant}) => {
  const localStart=`${tenant.anchor}T09:00`;
  const created=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{
    locationId:tenant.locationId,customerId:tenant.customerId,petId:tenant.petId,employeeId:tenant.employeeId,
    serviceIds:[tenant.serviceId],localStart,expectedLocationVersion:tenant.locationVersion
  }});
  expect(created.status()).toBe(201);
  expect((await created.json()).scheduledLocalStart).toContain(localStart);
  const context=await browser.newContext({baseURL:process.env.PAWSH_E2E_BASE_URL??"http://127.0.0.1:3000",timezoneId:"America/New_York"});
  const page=await context.newPage();
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar-list").locator(".week-time",{hasText:"9:00 AM"})).toBeVisible();
  await context.close();
});

test("@regression-calendar-time rejects nonexistent time and preserves both repeated occurrences", async ({request,tenant}) => {
  const base={locationId:tenant.locationId,customerId:tenant.customerId,petId:tenant.petId,employeeId:tenant.employeeId,
    serviceIds:[tenant.serviceId],expectedLocationVersion:tenant.locationVersion,availabilityOverride:true,overrideConflict:true,overrideReason:"DST regression"};
  const missing=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{...base,localStart:"2026-03-08T02:30"}});
  expect(missing.status()).toBe(400);
  expect((await missing.json()).code).toBe("NONEXISTENT_LOCAL_TIME");
  const ambiguous=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{...base,localStart:"2026-11-01T01:30"}});
  expect(ambiguous.status()).toBe(400);
  expect((await ambiguous.json()).code).toBe("AMBIGUOUS_LOCAL_TIME");
  const earlier=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{...base,localStart:"2026-11-01T01:30",disambiguation:"earlier"}});
  const later=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{...base,localStart:"2026-11-01T01:30",disambiguation:"later"}});
  expect(earlier.status()).toBe(201);
  expect(later.status()).toBe(201);
  expect(new Date((await later.json()).startAt).getTime()-new Date((await earlier.json()).startAt).getTime()).toBe(3_600_000);
});

test("@regression-calendar-time synchronizes week navigation and preselects an empty slot",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);await page.getByTestId("nav-calendar").click();
  await expect(page.locator("#month-grid")).toBeVisible();await expect(page.locator(".week-day-head")).toHaveCount(7);
  const initial=await page.locator("#calendar-range").textContent();await page.locator("#calendar-next-week").click();await expect(page.locator("#calendar-range")).not.toHaveText(initial??"");
  const nextRange=await page.locator("#calendar-range").textContent();await page.locator("#calendar-today").click();await expect(page.locator("#calendar-range")).not.toHaveText(nextRange??"");
  const slot=page.locator('.week-slot:not(.closed)').first();const preset=await slot.getAttribute("data-slot");await slot.click();await expect(page.getByTestId("field-startAt")).toHaveValue(preset??"");await page.getByRole("button",{name:"Cancel"}).click();
});

test("@cross-browser @regression-calendar-time exposes appointment actions and a compact rabies warning",async({page,request,tenant})=>{
  await createAppointment(request,tenant,{localStart:`${tenant.anchor}T09:00`});
  await login(page,tenant.ownerEmail);await page.getByTestId("nav-calendar").click();
  const card=page.locator(`.week-appointment[data-appointment-id]`).first();
  await expect(card.getByTestId("rabies-appointment-status")).toHaveText("Rabies needed");
  await expect(card.getByRole("button",{name:"Check in"})).toBeVisible();
  const actionMenu=card.locator(".calendar-actions-menu");await actionMenu.locator("summary").press("Enter");
  await expect(actionMenu).toHaveAttribute("open","");
  await expect(card.getByRole("button",{name:"Move"})).toBeVisible();
  await expect(card.getByRole("button",{name:"Cancel",exact:true})).toBeVisible();
  await expect(card.getByRole("button",{name:"No show"})).toBeVisible();
  await expect(card.locator("select")).toHaveCount(0);
});

test("@cross-browser @regression-calendar-time renders groomer day lanes and preserves slot click intent near an appointment",async({page,request,tenant})=>{
  const employeeResponse=await request.post("/api/employees",{data:{displayName:"Alex Groomer",serviceIds:[tenant.serviceId]}});
  expect(employeeResponse.status()).toBe(201);const secondEmployee=await employeeResponse.json() as {id:string};
  const inactiveResponse=await request.post("/api/employees",{data:{displayName:"Inactive Groomer",serviceIds:[tenant.serviceId]}});
  expect(inactiveResponse.status()).toBe(201);const inactiveEmployee=await inactiveResponse.json() as {id:string};
  expect((await request.delete(`/api/employees/${inactiveEmployee.id}`)).status()).toBe(204);
  expect((await request.put(`/api/employees/${secondEmployee.id}/working-hours`,{data:{hours:[1,2,3,4,5].map(weekday=>({weekday,startTime:"08:00",endTime:"18:00"}))}})).status()).toBe(204);
  const appointmentResponse=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{locationId:tenant.locationId,customerId:tenant.customerId,petId:tenant.petId,employeeIds:[tenant.employeeId,secondEmployee.id],serviceIds:[tenant.serviceId],localStart:`${tenant.anchor}T09:00`,expectedLocationVersion:tenant.locationVersion}});
  expect(appointmentResponse.status()).toBe(201);const appointment=await appointmentResponse.json() as {id:string};
  await login(page,tenant.ownerEmail);await page.getByTestId("nav-calendar").click();
  await page.locator("#calendar-day-view").click();
  await expect(page.locator("#calendar-day-view")).toHaveAttribute("aria-pressed","true");
  await expect(page.locator(".day-corner")).toHaveText("Time");
  await expect(page.locator(".day-groomer",{hasText:"Grace Groomer"})).toBeVisible();
  await expect(page.locator(".day-groomer",{hasText:"Inactive Groomer"})).toHaveCount(0);
  await expect(page.locator(`.day-appointment[data-appointment-id="${appointment.id}"]`)).toHaveCount(2);
  await page.locator(`.day-appointment[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();
  await expect(page.getByTestId("modal")).toBeVisible();await page.getByTestId("modal").getByRole("button",{name:"Close"}).click();
  const slot=page.locator(`.day-slot[data-slot="${tenant.anchor}T09:00"][data-slot-groomer="${tenant.employeeId}"]`);
  const box=await slot.boundingBox();expect(box).not.toBeNull();
  await slot.click({position:{x:box!.width-3,y:Math.min(10,box!.height/2)}});
  await expect(page.getByTestId("field-startAt")).toHaveValue(`${tenant.anchor}T09:00`);
  await expect(page.locator(`input[name="employeeIds"][value="${tenant.employeeId}"]`)).toBeChecked();
  await page.getByRole("button",{name:"Cancel",exact:true}).last().click();
  await page.locator(`.day-slot[data-slot="${tenant.anchor}T11:00"][data-slot-groomer="${secondEmployee.id}"]`).click({position:{x:185,y:18}});
  await page.getByTestId("field-customerId").selectOption(tenant.customerId);
  await page.getByTestId("field-petId").selectOption(tenant.petId);
  await expect(page.locator(`input[name="employeeIds"][value="${secondEmployee.id}"]`)).toBeChecked();
  await expect(page.locator(`input[name="employeeIds"][value="${tenant.employeeId}"]`)).not.toBeChecked();
  await expect(page.locator(`input[name="serviceIds"][value="${tenant.serviceId}"]`)).toBeChecked();
});
