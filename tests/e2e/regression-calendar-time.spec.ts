import { expect, login, test } from "./fixtures/tenant.js";

test("@regression-calendar-time keeps Los Angeles scheduling intent in a New York browser", async ({browser,request,tenant}) => {
  const localStart=`${tenant.anchor}T09:00`;
  const created=await request.post("/api/appointments",{data:{
    locationId:tenant.locationId,customerId:tenant.customerId,petId:tenant.petId,employeeId:tenant.employeeId,
    serviceIds:[tenant.serviceId],localStart,expectedLocationVersion:tenant.locationVersion
  }});
  expect(created.status()).toBe(201);
  expect((await created.json()).scheduledLocalStart).toContain(localStart);
  const context=await browser.newContext({baseURL:process.env.PAWSH_E2E_BASE_URL??"http://127.0.0.1:3000",timezoneId:"America/New_York"});
  const page=await context.newPage();
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar-list").getByText("9:00 AM")).toBeVisible();
  await context.close();
});

test("@regression-calendar-time rejects nonexistent time and preserves both repeated occurrences", async ({request,tenant}) => {
  const base={locationId:tenant.locationId,customerId:tenant.customerId,petId:tenant.petId,employeeId:tenant.employeeId,
    serviceIds:[tenant.serviceId],expectedLocationVersion:tenant.locationVersion,availabilityOverride:true,overrideConflict:true,overrideReason:"DST regression"};
  const missing=await request.post("/api/appointments",{data:{...base,localStart:"2026-03-08T02:30"}});
  expect(missing.status()).toBe(400);
  expect((await missing.json()).code).toBe("NONEXISTENT_LOCAL_TIME");
  const ambiguous=await request.post("/api/appointments",{data:{...base,localStart:"2026-11-01T01:30"}});
  expect(ambiguous.status()).toBe(400);
  expect((await ambiguous.json()).code).toBe("AMBIGUOUS_LOCAL_TIME");
  const earlier=await request.post("/api/appointments",{data:{...base,localStart:"2026-11-01T01:30",disambiguation:"earlier"}});
  const later=await request.post("/api/appointments",{data:{...base,localStart:"2026-11-01T01:30",disambiguation:"later"}});
  expect(earlier.status()).toBe(201);
  expect(later.status()).toBe(201);
  expect(new Date((await later.json()).startAt).getTime()-new Date((await earlier.json()).startAt).getTime()).toBe(3_600_000);
});
