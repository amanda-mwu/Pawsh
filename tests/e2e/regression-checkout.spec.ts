import { test,expect,login,completeAppointment,appointmentAction } from "./fixtures/tenant.js";
import { openCheckout,openAdjustment,chooseMethod,checkoutSurface } from "./helpers/checkout.js";
import type { Dialog } from "@playwright/test";

// The method radios offer the salon's own configured methods, which carry generated ids, so these
// specs pick the one a groomer would read rather than the settlement type underneath it. Every new
// business is provisioned with the four built-in methods, so "Cash" is always there.

const key=()=>crypto.randomUUID();

test("@regression-checkout duplicate UI and incompatible invoice intent reconcile",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  // Opened with no invoice, so this screen is building one.
  await openCheckout(page,appointment.id);
  await (await openAdjustment(page,"tip")).getByTestId("field-tip").fill("1");
  await chooseMethod(page,"Cash");

  // Somebody else raises the invoice while this screen is open, with different totals. That is the
  // only way the incompatible-intent refusal is now reachable: Check Out reads the appointment's
  // own `invoiceId`, so an invoice that already existed when it opened puts it in collect mode
  // instead of posting a second, conflicting checkout.
  const invoice=await request.post(`/api/appointments/${appointment.id}/checkout`,{
    headers:{"Idempotency-Key":key()},data:{discountMinor:0,discountType:null,tipMinor:0}
  });
  expect(invoice.status()).toBe(201);

  const submit=page.getByTestId("checkout-submit");
  let release!:()=>void;let entered!:()=>void;
  const arrived=new Promise<void>((resolve)=>{entered=resolve;});
  const continueRequest=new Promise<void>((resolve)=>{release=resolve;});
  await page.route(`**/api/appointments/${appointment.id}/checkout`,async(route)=>{entered();await continueRequest;await route.continue();});
  const clicking=submit.click();
  await arrived;
  await expect(submit).toBeDisabled();
  release();await clicking;
  await expect(page.locator("#checkout-error")).toContainText("invoice already exists with different checkout totals",{ignoreCase:true});
  await expect(page.locator("#checkout-error")).toContainText("Authoritative total");
});

// The state that will break silently if nobody writes it down: a second visit to Check Out on an
// invoice that already exists must take payment against it, never re-post the checkout that raised
// it. The fingerprint on that write includes the discounts, so a second post with anything
// different is answered with a 409 rather than the invoice the operator is looking at.
test("@regression-checkout an existing invoice is collected against, not raised again",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  const invoiceResponse=await request.post(`/api/appointments/${appointment.id}/checkout`,{
    headers:{"Idempotency-Key":key()},data:{discountMinor:0,discountType:null,tipMinor:0}
  });
  expect(invoiceResponse.status()).toBe(201);
  const invoice=await invoiceResponse.json();

  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  const checkoutPosts:string[]=[];
  page.on("request",(req)=>{
    if(req.method()==="POST"&&/\/api\/appointments\/[^/]+\/checkout$/.test(new URL(req.url()).pathname))checkoutPosts.push(req.url());
  });
  await openCheckout(page,appointment.id);

  // The bill is the invoice's, and it says so. Nothing that would change the invoice is offered.
  await expect(page.getByTestId("checkout-frozen")).toContainText("already raised");
  await expect(page.locator("[data-checkout-disclosure]")).toHaveCount(0);
  const due=`$${(invoice.totalMinor/100).toFixed(2)}`;
  await expect(page.getByTestId("checkout-balance")).toContainText(`Balance ${due}`);

  await chooseMethod(page,"Cash");
  await page.getByTestId("checkout-submit").click();
  await expect(page.getByTestId("receipt")).toContainText("Balance$0.00");
  expect(checkoutPosts,"an existing invoice must not be raised a second time").toEqual([]);
  const receipt=await request.get(`/api/invoices/${invoice.id}/receipt`);
  expect((await receipt.json()).invoice.balanceMinor).toBe(0);
});

test("@regression-checkout two-context stale payment refreshes without overpayment",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  const invoiceResponse=await request.post(`/api/appointments/${appointment.id}/checkout`,{
    headers:{"Idempotency-Key":key()},data:{discountMinor:0,discountType:null,tipMinor:0}
  });
  const invoice=await invoiceResponse.json();
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await openCheckout(page,appointment.id);
  await chooseMethod(page,"Cash");
  let release!:()=>void;
  let entered!:()=>void;
  const arrived=new Promise<void>((resolve)=>{entered=resolve;});
  const continueRequest=new Promise<void>((resolve)=>{release=resolve;});
  await page.route(`**/api/invoices/${invoice.id}/payments`,async(route)=>{entered();await continueRequest;await route.continue();});
  await page.getByTestId("checkout-submit").click();
  await arrived;
  const competing=await request.post(`/api/invoices/${invoice.id}/payments`,{
    headers:{"Idempotency-Key":key()},data:{amountMinor:4000,expectedBalanceMinor:invoice.balanceMinor,method:"cash"}
  });
  expect(competing.status()).toBe(201);
  release();
  // This screen did not raise the invoice, so it does not claim to have. The server's own sentence
  // is the whole story: the balance moved underneath it.
  await expect(page.locator("#checkout-error")).not.toContainText("Invoice created");
  await expect(page.locator("#checkout-error")).toContainText("balance changed",{ignoreCase:true});
  const receipt=await request.get(`/api/invoices/${invoice.id}/receipt`);
  expect((await receipt.json()).invoice.balanceMinor).toBe(invoice.balanceMinor-4000);
});

test("@regression-checkout receipt failure preserves committed payment and retries read only",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await openCheckout(page,appointment.id);
  await chooseMethod(page,"Cash");
  const paymentPosts:string[]=[];
  page.on("request",(req)=>{
    if(req.method()==="POST"&&/\/api\/invoices\/[^/]+\/payments$/.test(new URL(req.url()).pathname))paymentPosts.push(req.url());
  });
  await page.route("**/api/invoices/*/receipt",(route)=>route.fulfill({status:429,contentType:"application/json",body:JSON.stringify({error:"temporary"})}));
  await page.getByTestId("checkout-submit").click();
  await expect(page.locator("#checkout-error")).toContainText("Payment recorded successfully. Receipt is temporarily unavailable.");
  await page.unroute("**/api/invoices/*/receipt");
  await page.getByTestId("checkout-submit").click();
  await expect(page.getByTestId("receipt")).toContainText("Balance$0.00");
  const voids=await page.getByTestId("receipt").locator(".void-payment").count();
  expect(voids).toBe(1);
  // The retry is a read. Pressing the button again after the money landed must never take it twice.
  expect(paymentPosts.length,"the retry took a second payment").toBe(1);
});

// A settled checkout IS the receipt, so the corrections that belong to a receipt are offered on it
// rather than behind a second dialog carrying a second copy of the same bill.
test("@regression-checkout a settled checkout offers the receipt's own corrections in place",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await openCheckout(page,appointment.id);
  await chooseMethod(page,"Cash");
  await page.getByTestId("checkout-submit").click();

  const surface=checkoutSurface(page);
  await expect(surface.getByTestId("receipt")).toContainText("Balance$0.00");
  const total=(await surface.getByTestId("receipt").textContent())!.match(/Total(\$[\d,.]+)/)![1]!;
  await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $0.00");
  // Never "Take payment" against a zero balance: coming back to that is a route to a double charge.
  await expect(page.getByTestId("checkout-submit")).toHaveCount(0);
  await expect(page.getByTestId("checkout-done")).toBeVisible();
  await expect(page.getByTestId("checkout-print-receipt")).toBeVisible();

  // Voiding asks for a reason and then confirms, so one handler answers both in order.
  const answer=(dialog:Dialog)=>dialog.accept(dialog.type()==="prompt"?"Keyed the wrong amount":"");
  page.on("dialog",answer);
  await surface.getByRole("button",{name:"Void record"}).click();
  // The void puts the money back on the bill, so this screen goes back to collecting it - in
  // place, without closing the surface or stacking a modal copy of the same receipt on top of it.
  await expect(page.getByTestId("checkout-balance")).toHaveText(`Balance ${total}`);
  await expect(page.getByTestId("checkout-submit")).toBeVisible();
  await expect(page.getByTestId("checkout-done")).toHaveCount(0);
  await expect(page.getByTestId("modal")).toBeHidden();
  page.off("dialog",answer);
});

test("@regression-checkout a double-pressed checkout opens one working surface and submits once",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  // A card processor gives the salon its three tip presets, which is what proves the surface on
  // screen is bound: the presets only compute if bindCheckoutTips ran against these nodes.
  const processor=await request.post("/api/settings/card-processors",{data:{provider:"square",locationLabel:"Front desk"}});
  expect(processor.ok(),await processor.text()).toBeTruthy();

  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");

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
  // was read twice and the whole screen was rebuilt and rebound underneath the operator, discarding
  // anything already typed into the first copy.
  await expect.poll(()=>optionReads.length,{message:"checkout() ran twice for one appointment"}).toBe(1);
  await expect(page.getByTestId("field-method")).toBeVisible();
  expect(await page.locator("#appointment-checkout [data-testid='field-method']").count()).toBe(1);

  // Still a working surface, not merely a single one: the presets compute and the invoice posts once.
  const tip=await openAdjustment(page,"tip");
  await tip.getByRole("button",{name:"18%"}).click();
  await expect(page.getByTestId("field-tip")).toHaveValue("15.30");
  await chooseMethod(page,"Cash");
  await page.getByTestId("checkout-submit").click();
  await expect(page.getByTestId("receipt")).toContainText("Balance$0.00");
  expect(checkoutPosts.length,"the appointment was checked out more than once").toBe(1);
});
