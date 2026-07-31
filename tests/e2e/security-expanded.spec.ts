import {
  test, expect, login, createMember, createTenant, completeAppointment, ownerPermissions, password
} from "./fixtures/tenant.js";
import { request as playwrightRequest } from "@playwright/test";

test("@security-desktop revoked server session reconciles stale browser authority",async({page,request,tenant})=>{
  await login(page,tenant.ownerEmail);
  const requested=await request.post("/api/auth/password-reset/request",{data:{email:tenant.ownerEmail}});
  expect(requested.status()).toBe(200);
  const token=(await requested.json()).developmentToken;
  expect(token).toBeTruthy();
  const confirmed=await request.post("/api/auth/password-reset/confirm",{
    data:{token,password:"replacement browser security password"}
  });
  expect(confirmed.status()).toBe(200);

  await page.getByTestId("nav-customers").click();
  await expect(page.locator("#auth-view")).toBeVisible();
  await expect(page.locator("#app-view")).toBeHidden();
  expect(await page.evaluate(async()=>(await fetch("/api/me",{credentials:"include"})).status)).toBe(401);
  await page.reload();
  await expect(page.locator("#auth-view")).toBeVisible();
  await expect(page.locator("#app-view")).toBeHidden();
});

test("@security-desktop stale permission cannot mutate and reconciles capability",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  const email=`stale+${tenant.runId}@pawsh-test.example`;
  const member=await createMember(request,email,ownerPermissions);
  await login(page,email,password);
  await page.getByTestId("nav-calendar").click();
  const checkout=page.locator(`[data-appointment-id="${appointment.id}"]`).getByTestId("appointment-completed");
  await expect(checkout).toBeVisible();

  await request.patch(`/api/members/${member.membershipId}/permissions`,{
    data:{permissions:ownerPermissions.filter((permission)=>permission!=="checkout.perform")}
  });
  await checkout.click();
  await page.getByTestId("field-method").selectOption("cash");
  await page.getByTestId("modal-submit").click();
  await expect(page.locator("#modal-error")).toContainText("Missing permission: checkout.perform");
  await expect(checkout).toBeHidden();

  const ownerCheckout=await request.post(`/api/appointments/${appointment.id}/checkout`,{
    headers:{"Idempotency-Key":crypto.randomUUID()},
    data:{discountMinor:0,tipMinor:0}
  });
  expect(ownerCheckout.status()).toBe(201);
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.locator(`[data-appointment-id="${appointment.id}"]`).getByTestId("appointment-completed")).toBeHidden();
});

test("@security-desktop browser cookie context cannot cross tenant boundary",async({page,tenant})=>{
  const baseURL=process.env.PAWSH_E2E_BASE_URL??"http://127.0.0.1:3000";
  const tenantBApi=await playwrightRequest.newContext({baseURL});
  const tenantB=await createTenant(tenantBApi,"security-browser-tenant-b");
  await login(page,tenant.ownerEmail);
  const attempt=await page.evaluate(async(customerId)=>{
    const response=await fetch(`/api/customers/${customerId}/history`,{credentials:"include"});
    return {status:response.status,body:await response.text()};
  },tenantB.customerId);
  expect(attempt.status).toBe(404);
  expect(attempt.body).not.toContain(tenantB.ownerEmail);
  expect(attempt.body).not.toContain("security-browser-tenant-b");
  await tenantBApi.dispose();
});

test("@security-permission-parity restricted capability stays hidden and denied",async({page,request,tenant})=>{
  const email=`parity+${tenant.runId}@pawsh-test.example`;
  await createMember(request,email,["calendar.view"]);
  await login(page,email,password);

  await expect(page.getByTestId("nav-setup")).toBeHidden();
  await expect(page.getByTestId("nav-setup")).not.toBeFocused();
  const status=await page.evaluate(async()=>(
    await fetch("/api/business/settings",{
      method:"PUT",credentials:"include",headers:{"content-type":"application/json"},
      body:JSON.stringify({
        name:"Unauthorized",timezone:"America/Los_Angeles",currency:"USD",
        taxRateBasisPoints:0,reminderLeadMinutes:0
      })
    })
  ).status);
  expect(status).toBe(403);
  await page.reload();
  await expect(page.getByTestId("nav-setup")).toBeHidden();
});
