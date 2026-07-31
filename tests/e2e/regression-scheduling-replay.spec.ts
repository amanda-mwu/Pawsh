import { expect, login, test } from "./fixtures/tenant.js";

test("@regression-scheduling-replay reconciles a repeated create into one calendar appointment",async({page,request,tenant})=>{
  const key=crypto.randomUUID();
  const payload={locationId:tenant.locationId,customerId:tenant.customerId,petId:tenant.petId,
    employeeId:tenant.employeeId,serviceIds:[tenant.serviceId],localStart:`${tenant.anchor}T10:00`,
    expectedLocationVersion:tenant.locationVersion};
  const first=await request.post("/api/appointments",{headers:{"Idempotency-Key":key},data:payload});
  const replay=await request.post("/api/appointments",{headers:{"Idempotency-Key":key},data:payload});
  expect(first.status()).toBe(201);
  expect(replay.status()).toBe(200);
  expect((await replay.json()).id).toBe((await first.json()).id);
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar-list").getByText("Charlie")).toHaveCount(1);
});

test("@regression-scheduling-replay replays a reschedule before stale version checks and rejects changed intent",async({request,tenant})=>{
  const createKey=crypto.randomUUID();
  const created=await request.post("/api/appointments",{headers:{"Idempotency-Key":createKey},data:{
    locationId:tenant.locationId,customerId:tenant.customerId,petId:tenant.petId,employeeId:tenant.employeeId,
    serviceIds:[tenant.serviceId],localStart:`${tenant.anchor}T11:00`,expectedLocationVersion:tenant.locationVersion
  }});
  const appointment=await created.json();
  const key=crypto.randomUUID();
  const move={employeeId:tenant.employeeId,localStart:`${tenant.anchor}T13:00`,
    expectedLocationVersion:tenant.locationVersion,version:appointment.version};
  const first=await request.patch(`/api/appointments/${appointment.id}/schedule`,{headers:{"Idempotency-Key":key},data:move});
  const replay=await request.patch(`/api/appointments/${appointment.id}/schedule`,{headers:{"Idempotency-Key":key},data:move});
  expect(first.status()).toBe(200);
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toMatchObject({id:appointment.id,version:(await first.json()).version,scheduledLocalStart:move.localStart});
  const mismatch=await request.patch(`/api/appointments/${appointment.id}/schedule`,{
    headers:{"Idempotency-Key":key},data:{...move,localStart:`${tenant.anchor}T14:00`}
  });
  expect(mismatch.status()).toBe(409);
  expect((await mismatch.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");
});
