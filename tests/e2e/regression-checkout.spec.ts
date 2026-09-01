import { test,expect,login,completeAppointment,appointmentAction } from "./fixtures/tenant.js";

// The method select offers the salon's own configured methods, which carry generated ids, so these
// specs pick the one a groomer would read rather than the settlement type underneath it. Every new
// business is provisioned with the four built-in methods, so "Cash" is always there.

const key=()=>crypto.randomUUID();

test("@regression-checkout duplicate UI and incompatible invoice intent reconcile",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  const invoice=await request.post(`/api/appointments/${appointment.id}/checkout`,{
    headers:{"Idempotency-Key":key()},data:{discountMinor:0,discountType:null,tipMinor:0}
  });
  expect(invoice.status()).toBe(201);
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await (await appointmentAction(page.locator(`[data-appointment-id="${appointment.id}"]`),"appointment-completed")).click();
  await page.getByTestId("field-tip").fill("1");
  await page.getByTestId("field-method").selectOption({label:"Cash"});
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
  await (await appointmentAction(page.locator(`[data-appointment-id="${appointment.id}"]`),"appointment-completed")).click();
  await page.getByTestId("field-method").selectOption({label:"Cash"});
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
  await (await appointmentAction(page.locator(`[data-appointment-id="${appointment.id}"]`),"appointment-completed")).click();
  await page.getByTestId("field-method").selectOption({label:"Cash"});
  await page.route("**/api/invoices/*/receipt",(route)=>route.fulfill({status:429,contentType:"application/json",body:JSON.stringify({error:"temporary"})}));
  await page.getByTestId("modal-submit").click();
  await expect(page.locator("#modal-error")).toContainText("Payment recorded successfully. Receipt is temporarily unavailable.");
  await page.unroute("**/api/invoices/*/receipt");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("receipt")).toContainText("Balance$0.00");
  const payments=await page.getByTestId("receipt").locator(".void-payment").count();
  expect(payments).toBe(1);
});

test("@regression-checkout a double-pressed checkout opens one working modal and submits once",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  // A card processor gives the salon its three tip presets, which is what proves the modal on
  // screen is bound: the presets only compute if bindCheckoutTips ran against these nodes.
  const processor=await request.post("/api/settings/card-processors",{data:{provider:"square",locationLabel:"Front desk"}});
  expect(processor.ok(),await processor.text()).toBeTruthy();

  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();

  // checkout() reads the salon's payment options before it can open anything. Holding that read
  // open widens the window a second press lands in - the window the guard exists for.
  let release!:()=>void;let entered!:()=>void;
  const arrived=new Promise<void>((resolve)=>{entered=resolve;});
  const continueRequest=new Promise<void>((resolve)=>{release=resolve;});
  const optionReads:string[]=[];
  await page.route("**/api/checkout/payment-options",async(route)=>{
    optionReads.push(route.request().url());entered();await continueRequest;await route.continue();
  });
  const checkoutPosts:string[]=[];
  page.on("request",(req)=>{
    if(req.method()==="POST"&&/\/api\/appointments\/[^/]+\/checkout$/.test(new URL(req.url()).pathname))checkoutPosts.push(req.url());
  });

  const action=await appointmentAction(page.locator(`[data-appointment-id="${appointment.id}"]`),"appointment-completed");
  // Two clicks in one task, which is what a double-press is. Dispatching them directly rather than
  // clicking twice keeps the reproduction independent of whether the action menu stays open.
  await action.evaluate((element:HTMLElement)=>{element.click();element.click();});
  await arrived;
  release();

  // The regression. Both presses used to enter checkout(), because the completed branch returned
  // before the runOnce that guards every other transition - so the salon's payment configuration
  // was read twice and the whole modal was rebuilt and rebound underneath the operator, discarding
  // anything already typed into the first copy. showModal() on an already-modal dialog is a no-op
  // rather than a throw, so nothing announced this; the duplicated read is what makes it visible.
  await expect.poll(()=>optionReads.length,{message:"checkout() ran twice for one appointment"}).toBe(1);
  await expect(page.getByTestId("field-method")).toBeVisible();
  expect(await page.locator("#modal-fields [data-testid='field-method']").count()).toBe(1);

  // Still a working modal, not merely a single one: the presets compute and the invoice posts once.
  await page.getByRole("button",{name:"18%"}).click();
  await expect(page.getByTestId("field-tip")).toHaveValue("15.30");
  await page.getByTestId("field-method").selectOption({label:"Cash"});
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("receipt")).toContainText("Balance$0.00");
  expect(checkoutPosts.length,"the appointment was checked out more than once").toBe(1);
});
