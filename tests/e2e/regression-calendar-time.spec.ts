import { expect, login, test } from "./fixtures/tenant.js";

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
