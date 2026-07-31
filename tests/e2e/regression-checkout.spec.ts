import { test,expect,login,completeAppointment } from "./fixtures/tenant.js";

const key=()=>crypto.randomUUID();

test("@regression-checkout duplicate UI and incompatible invoice intent reconcile",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  const invoice=await request.post(`/api/appointments/${appointment.id}/checkout`,{
    headers:{"Idempotency-Key":key()},data:{discountMinor:0,discountType:null,tipMinor:0}
  });
  expect(invoice.status()).toBe(201);
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.locator(`[data-appointment-id="${appointment.id}"]`).getByTestId("appointment-completed").click();
  await page.getByTestId("field-tip").fill("1");
  await page.getByTestId("field-method").selectOption("cash");
  const submit=page.getByTestId("modal-submit");
  let release!:()=>void;let entered!:()=>void;
  const arrived=new Promise<void>((resolve)=>{entered=resolve;});
  const continueRequest=new Promise<void>((resolve)=>{release=resolve;});
  await page.route(`**/api/appointments/${appointment.id}/checkout`,async(route)=>{entered();await continueRequest;await route.continue();});
  const clicking=submit.click();
  await arrived;
  await expect(submit).toBeDisabled();
  release();await clicking;
  await expect(page.locator("#modal-error")).toContainText("invoice already exists with different checkout totals",{ignoreCase:true});
  await expect(page.locator("#modal-error")).toContainText("Authoritative total");
});

test("@regression-checkout two-context stale payment refreshes without overpayment",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  const invoiceResponse=await request.post(`/api/appointments/${appointment.id}/checkout`,{
    headers:{"Idempotency-Key":key()},data:{discountMinor:0,discountType:null,tipMinor:0}
  });
  const invoice=await invoiceResponse.json();
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.locator(`[data-appointment-id="${appointment.id}"]`).getByTestId("appointment-completed").click();
  await page.getByTestId("field-method").selectOption("cash");
  let release!:()=>void;
  let entered!:()=>void;
  const arrived=new Promise<void>((resolve)=>{entered=resolve;});
  const continueRequest=new Promise<void>((resolve)=>{release=resolve;});
  await page.route(`**/api/invoices/${invoice.id}/payments`,async(route)=>{entered();await continueRequest;await route.continue();});
  await page.getByTestId("modal-submit").click();
  await arrived;
  const competing=await request.post(`/api/invoices/${invoice.id}/payments`,{
    headers:{"Idempotency-Key":key()},data:{amountMinor:4000,expectedBalanceMinor:invoice.balanceMinor,method:"cash"}
  });
  expect(competing.status()).toBe(201);
  release();
  await expect(page.locator("#modal-error")).toContainText("Invoice created; payment remains pending");
  await expect(page.locator("#modal-error")).toContainText("balance changed",{ignoreCase:true});
  const receipt=await request.get(`/api/invoices/${invoice.id}/receipt`);
  expect((await receipt.json()).invoice.balanceMinor).toBe(invoice.balanceMinor-4000);
});

test("@regression-checkout receipt failure preserves committed payment and retries read only",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.locator(`[data-appointment-id="${appointment.id}"]`).getByTestId("appointment-completed").click();
  await page.getByTestId("field-method").selectOption("cash");
  await page.route("**/api/invoices/*/receipt",(route)=>route.fulfill({status:429,contentType:"application/json",body:JSON.stringify({error:"temporary"})}));
  await page.getByTestId("modal-submit").click();
  await expect(page.locator("#modal-error")).toContainText("Payment recorded successfully. Receipt is temporarily unavailable.");
  await page.unroute("**/api/invoices/*/receipt");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("receipt")).toContainText("Balance$0.00");
  const payments=await page.getByTestId("receipt").locator(".void-payment").count();
  expect(payments).toBe(1);
});
