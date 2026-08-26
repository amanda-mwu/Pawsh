import { test, expect, login, createAppointment, completeAppointment, appointmentAction } from "../fixtures/tenant.js";

test("@smoke operations expose safety context and enforce the state machine",async({page,request,tenant})=>{
  const appointment=await createAppointment(request,tenant,{
    customerId:tenant.rockyCustomerId,petId:tenant.rockyPetId
  });
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  const row=page.locator(`[data-appointment-id="${appointment.id}"]`);
  await expect(row.getByTestId("safety-context")).toContainText("May snap during nail handling.");
  await expect(row.getByTestId("safety-context")).toContainText("Mild hip stiffness.");
  // Only the safety alert is an alarm. When every care note was red the one line meaning "this
  // dog may bite" looked exactly like a note about coat length, so the colour is spent on it
  // alone and the other notes render in ordinary ink.
  const alarm=row.locator(".care-alarm");
  await expect(alarm).toHaveCount(1);
  await expect(alarm).toContainText("May snap during nail handling.");
  await expect(alarm).toHaveCSS("color","rgb(179, 38, 30)");
  const plain=row.locator(".care-note:not(.care-alarm)").first();
  await expect(plain).not.toHaveCSS("color","rgb(179, 38, 30)");
  await (await appointmentAction(row,"appointment-scheduled")).click();
  await expect(page.getByTestId("modal")).toContainText("May snap during nail handling.");
  await page.getByTestId("modal-submit").click();
  await (await appointmentAction(page.locator(`[data-appointment-id="${appointment.id}"]`),"appointment-checked_in")).click();
  await expect(page.getByTestId("modal")).toContainText("Nervous around paws.");
  await page.getByTestId("field-operationalNotes").fill("Used calm paw-handling technique.");
  await page.getByTestId("modal-submit").click();
  page.once("dialog",(dialog)=>dialog.accept());
  await (await appointmentAction(page.locator(`[data-appointment-id="${appointment.id}"]`),"appointment-in_service")).click();
  await expect(page.locator(`[data-appointment-id="${appointment.id}"]`)).toContainText("completed");
  const invalid=await page.request.post(`/api/appointments/${appointment.id}/transition`,{data:{status:"checked_in"}});
  expect(invalid.status()).toBe(400);
});

test("@smoke @regression-checkout checkout totals persist and manual payment correction remains explicit",async({page,request,tenant})=>{
  const appointment=await completeAppointment(request,tenant);
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await (await appointmentAction(page.locator(`[data-appointment-id="${appointment.id}"]`),"appointment-completed")).click();
  await page.getByTestId("field-discount").fill("5");
  await page.getByTestId("field-tip").fill("15");
  await page.getByTestId("field-method").selectOption("cash");
  await page.getByTestId("modal-submit").click();
  const receipt=page.getByTestId("receipt");
  await expect(receipt).toContainText("Subtotal$85.00");
  await expect(receipt).toContainText("Discount-$5.00");
  await expect(receipt).toContainText("Tax$6.60");
  await expect(receipt).toContainText("Tip$15.00");
  await expect(receipt).toContainText("Total$101.60");
  await expect(receipt).toContainText("Balance$0.00");
  const dialogs:string[]=[];
  page.on("dialog",async(dialog)=>{
    dialogs.push(dialog.message());
    if(dialog.type()==="prompt")await dialog.accept("Duplicate terminal entry");
    else await dialog.accept();
  });
  await page.getByRole("button",{name:"Void record"}).click();
  await expect(page.getByTestId("receipt")).toContainText("Balance$101.60");
  expect(dialogs.join(" ")).toContain("does not refund external funds");
  const audit=await page.evaluate(async()=>(
    await fetch("/api/audit",{credentials:"include"})
  ).json() as Promise<Array<{action:string}>>);
  expect(audit.some((entry)=>entry.action==="payment.void")).toBeTruthy();
});
