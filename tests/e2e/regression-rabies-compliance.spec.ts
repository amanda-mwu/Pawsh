import {expect,login,test} from "./fixtures/tenant.js";
import { cardForPet, petAction } from "./helpers/clients.js";
import { chooseBookingClient, chooseBookingPet, fillBooking, openBooking, submitBooking } from "./helpers/booking.js";

function addDays(dateOnly:string,days:number):string {
  const date=new Date(`${dateOnly}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}

test("@regression-lifecycle enters only rabies expiration and warns for the appointment date",async({page,tenant})=>{
  const expiration=addDays(tenant.anchor,-1);
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await petAction(cardForPet(page, tenant.petId), "care", tenant.petId);
  await expect(page.getByRole("group",{name:"Rabies Information"})).toBeVisible();
  await page.getByTestId("field-vaccinationExpiresOn").fill(expiration);
  await expect(page.getByTestId("field-rabiesVerificationStatus")).toHaveCount(0);
  await expect(page.getByTestId("field-rabiesVerificationMethod")).toHaveCount(0);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  await page.getByTestId("nav-calendar").click();
  await openBooking(page);
  await chooseBookingClient(page,tenant.customerId);
  await chooseBookingPet(page,tenant.petId);
  await fillBooking(page,{employeeId:tenant.employeeId,startAt:`${tenant.anchor}T09:00`});
  // Entering the date is what makes the record lapsed, so the prompt interrupts here rather
  // than when the client was chosen against no date at all.
  await expect(page.getByTestId("booking-vaccination-pets")).toContainText("Charlie");
  await page.getByTestId("stacked-dialog-dismiss").click();
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
  await expect(page.getByTestId("booking-rabies-status")).toContainText("Expires before appointment");
  await submitBooking(page);
  await expect(page.getByTestId("booking-dialog")).toBeHidden();
  await expect(page.getByTestId("rabies-appointment-status")).toHaveText("Rabies needed");
});

// Dismissing the prompt leaves the client unmessaged; sending queues a customer-scoped
// reminder before the appointment exists at all.
test("@regression-lifecycle queues a vaccination reminder from the booking prompt",async({page,tenant})=>{
  const expiration=addDays(tenant.anchor,-1);
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await petAction(cardForPet(page, tenant.petId), "care", tenant.petId);
  await page.getByTestId("field-vaccinationExpiresOn").fill(expiration);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  await page.getByTestId("nav-calendar").click();
  await openBooking(page);
  await chooseBookingClient(page,tenant.customerId);
  await chooseBookingPet(page,tenant.petId);
  await fillBooking(page,{employeeId:tenant.employeeId,startAt:`${tenant.anchor}T09:00`});
  await expect(page.getByTestId("booking-vaccination-pets")).toBeVisible();
  const queued=page.waitForResponse(response=>
    response.url().includes("/vaccination-reminder")&&response.request().method()==="POST");
  await page.getByTestId("stacked-dialog-confirm").click();
  expect((await queued).status()).toBe(202);
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
});
