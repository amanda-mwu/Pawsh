import { request as playwrightRequest } from "@playwright/test";
import {
  test,expect,login,createMember,completeAppointment,createTenant,
  ownerPermissions,password,appointmentAction
} from "../fixtures/tenant.js";

test("@smoke browser security enforces permission changes and protects ownership",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  const email=`reception+${tenant.runId}@pawsh-test.example`;
  const initial=ownerPermissions.filter((permission)=>permission!=="checkout.perform"&&permission!=="reports.view"&&permission!=="settings.manage");
  const member=await createMember(request,email,initial);
  await login(page,email,password);
  await page.getByTestId("nav-calendar").click();
  await expect(page.locator(`[data-appointment-id="${appointment.id}"]`).getByTestId("appointment-completed")).toHaveCount(0);
  const deniedStatus=await page.evaluate(async(id)=>{
    const response=await fetch(`/api/appointments/${id}/checkout`,{
      method:"POST",credentials:"include",headers:{"content-type":"application/json"},
      body:JSON.stringify({discountMinor:0,tipMinor:0})
    });
    return response.status;
  },appointment.id);
  expect(deniedStatus).toBe(403);
  await request.patch(`/api/members/${member.membershipId}/permissions`,{data:{permissions:[...initial,"checkout.perform"]}});
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(await appointmentAction(page.locator(`[data-appointment-id="${appointment.id}"]`),"appointment-completed")).toBeVisible();
  const ownerRemoval=await request.delete(`/api/members/${tenant.ownerMembershipId}`);
  expect(ownerRemoval.status()).toBe(400);
});

test("@smoke tenant identifiers do not cross browser-authenticated security boundaries",async({request,tenant})=>{
  const baseURL=process.env.PAWSH_E2E_BASE_URL??"http://127.0.0.1:3000";
  const tenantBApi=await playwrightRequest.newContext({baseURL});
  const tenantB=await createTenant(tenantBApi,"tenant-b-security");
  const appointmentB=await completeAppointment(tenantBApi,tenantB);
  const invoiceB=await tenantBApi.post(`/api/appointments/${appointmentB.id}/checkout`,{
    headers:{"Idempotency-Key":crypto.randomUUID()},data:{discountMinor:0,tipMinor:0}
  });
  const invoice=await invoiceB.json();
  const attempts=[
    await request.get(`/api/customers/${tenantB.customerId}/history`),
    await request.post(`/api/pets/${tenantB.petId}/archive`),
    await request.post(`/api/appointments/${appointmentB.id}/transition`,{data:{status:"checked_in"}}),
    await request.get(`/api/invoices/${invoice.id}/receipt`)
  ];
  for(const response of attempts){
    expect([404,400]).toContain(response.status());
    const body=await response.text();
    expect(body).not.toContain(tenantB.ownerEmail);
    expect(body).not.toContain("PW Smoke tenant-b-security");
  }
  await tenantBApi.dispose();
  expect(tenant.businessId).not.toBe(tenantB.businessId);
});
