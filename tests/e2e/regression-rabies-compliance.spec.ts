import {expect,login,test} from "./fixtures/tenant.js";
import { cardForPet, petAction } from "./helpers/clients.js";

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
  await page.getByTestId("calendar-add-appointment").click();
  await page.getByTestId("field-customerId").selectOption(tenant.customerId);
  await page.getByTestId("field-petId").selectOption(tenant.petId);
  await page.locator('select[name="employeeId"]').selectOption(tenant.employeeId);
  await page.getByRole("checkbox",{name:/Full Groom/}).check();
  await page.getByTestId("field-startAt").fill(`${tenant.anchor}T09:00`);
  await expect(page.getByTestId("booking-rabies-status")).toContainText("Expires before appointment");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await expect(page.getByTestId("rabies-appointment-status")).toHaveText("Rabies needed");
});
