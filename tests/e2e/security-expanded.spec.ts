import {
  test, expect, login, createMember, createTenant, completeAppointment, ownerPermissions, password,
  appointmentAction, setMemberPermissions
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
  const checkout=await appointmentAction(page.locator(`[data-appointment-id="${appointment.id}"]`),"appointment-completed");
  await expect(checkout).toBeVisible();

  // Revoking is done by editing the member's ROLE, and takes effect on their next request: the
  // session is not invalidated and nothing is cached.
  await setMemberPermissions(request,member.roleId,
    ownerPermissions.filter((permission)=>permission!=="checkout.perform"));
  const staleCheckoutStatus=await page.evaluate(async(appointmentId)=>(await fetch(`/api/appointments/${appointmentId}/checkout`,{
    method:"POST",
    credentials:"include",
    headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},
    body:JSON.stringify({discountMinor:0,tipMinor:0,method:"cash"})
  })).status,appointment.id);
  expect(staleCheckoutStatus).toBe(403);
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.locator(`[data-appointment-id="${appointment.id}"]`).getByTestId("appointment-completed")).toHaveCount(0);

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

test("@security-desktop tenant-typed settings text cannot escape the attributes it renders into",async({page,request,tenant})=>{
  // A quote is the whole attack. `escape()` serialises a text node, which keeps quotes intact, so
  // any of this text interpolated into a double-quoted attribute used to close that attribute early
  // and let everything after it parse as markup - reaching whoever opened the screen next, which on
  // a settings page a staff member can reach is the owner.
  const payload = 'Tap" data-pwned="1';
  const method=await request.post("/api/settings/payment-methods",{
    data:{name:payload,settlementType:"external_card",enabled:true}
  });
  expect(method.ok(),await method.text()).toBeTruthy();
  const methodId=(await method.json()).paymentMethods.find((entry:{name:string})=>entry.name===payload).id;
  const processor=await request.post("/api/settings/card-processors",{
    data:{provider:"square",locationLabel:payload}
  });
  expect(processor.ok(),await processor.text()).toBeTruthy();

  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-settings").click();
  await page.locator('[data-settings-category="tax-payments"]').click();
  // Anchored on the row itself. The table renders a "Loading…" row before the payload arrives, so
  // asserting the absence of an injected attribute any earlier would pass against an empty screen.
  const edit=page.locator(`[data-taxpay-method-edit="${methodId}"]`);
  await expect(edit).toBeVisible();
  // The name survived whole rather than being truncated at the quote - which is the same fix seen
  // from the accessibility side: a screen reader announces the method the operator actually named.
  await expect(edit).toHaveAttribute("aria-label",`Edit ${payload}`);
  // And nothing on the screen picked up the attribute the payload tried to open.
  await expect(page.locator("[data-pwned]")).toHaveCount(0);

  await page.getByTestId("taxpay-tab-processors").click();
  const location=page.locator("[data-taxpay-location]");
  await expect(location).toBeVisible();
  // The value attribute is the clearest sink of the group: free text straight back into markup.
  await expect(location).toHaveValue(payload);
  await expect(page.locator("[data-pwned]")).toHaveCount(0);
});
