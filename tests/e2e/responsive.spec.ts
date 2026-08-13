import { createAppointment, test, expect, login } from "./fixtures/tenant.js";
import type { Page } from "@playwright/test";
import {
  expectAuthenticatedSurface,
  expectCriticalTarget,
  expectDialogControlsReachable,
  expectNoDocumentOverflow,
  expectUnauthenticatedSurface,
} from "./helpers/responsive.js";
async function openNavigation(page:Page){if(await page.locator("#mobile-nav-toggle").isVisible()&&await page.getByTestId("nav-calendar").isHidden())await page.locator("#mobile-nav-toggle").click();}

test("@responsive auth navigation reload and logout remain coherent",async({page,tenant},testInfo)=>{
  await login(page,tenant.ownerEmail);
  await expectAuthenticatedSurface(page);
  await openNavigation(page);
  expect(await page.evaluate(async()=>(await fetch("/api/me",{credentials:"include"})).status)).toBe(200);
  await expectCriticalTarget(page.getByTestId("nav-customers"));
  await page.getByTestId("nav-customers").click();
  await expect(page.getByTestId("customers-view")).toBeVisible();
  await expectNoDocumentOverflow(page,testInfo);

  await page.reload();
  await expectAuthenticatedSurface(page);
  expect(await page.evaluate(async()=>(await fetch("/api/me",{credentials:"include"})).status)).toBe(200);
  await expectCriticalTarget(page.getByTestId("account-trigger"));
  await page.getByTestId("account-trigger").click();
  await expectCriticalTarget(page.getByTestId("logout"));
  await page.getByTestId("logout").click();
  await expectUnauthenticatedSurface(page);
  expect(await page.evaluate(async()=>(await fetch("/api/me",{credentials:"include"})).status)).toBe(401);
});

test("@responsive customer and pet creation remains customer scoped",async({page,tenant},testInfo)=>{
  const suffix=tenant.runId.slice(-8);
  const customerName=`Responsive ${suffix}`;
  const petName=`Scout ${suffix.slice(-5)}`;
  await login(page,tenant.ownerEmail);
  await openNavigation(page);
  await page.getByTestId("nav-customers").click();
  await expectNoDocumentOverflow(page,testInfo);

  await expectCriticalTarget(page.getByTestId("new-customer"));
  await page.getByTestId("new-customer").click();
  await page.getByTestId("field-firstName").fill("Responsive");
  await page.getByTestId("field-lastName").fill(suffix);
  await page.getByTestId("field-email").fill(`responsive+${tenant.runId}@pawsh-test.example`);
  await page.getByTestId("modal-submit").scrollIntoViewIfNeeded();
  await page.getByTestId("modal-submit").click();
  const customer=page.getByTestId("customer-card").filter({hasText:customerName});
  await expect(customer).toBeVisible();

  await page.getByRole("button",{name:/\+ Pet/}).click();
  const option=page.getByTestId("field-customerId").locator("option",{hasText:customerName});
  const customerId=await option.getAttribute("value");
  expect(customerId).toBeTruthy();
  await page.getByTestId("field-customerId").selectOption(customerId!);
  await page.getByTestId("field-name").fill(petName);
  await page.getByTestId("modal-submit").scrollIntoViewIfNeeded();
  await page.getByTestId("modal-submit").click();
  await expect(customer).toContainText(petName);

  await openNavigation(page);await page.getByTestId("nav-calendar").click();
  await page.getByTestId("calendar-add-appointment").click();
  await page.getByTestId("field-customerId").selectOption(customerId!);
  await expect(page.getByTestId("field-petId").locator("option",{hasText:petName})).toHaveCount(1);
  await expect(page.getByTestId("field-petId").locator(`option[value="${tenant.petId}"]`)).toHaveCount(0);
});

test("@responsive calendar booking remains usable and persistent",async({page,tenant},testInfo)=>{
  await login(page,tenant.ownerEmail);
  await openNavigation(page);
  await page.getByTestId("nav-calendar").click();
  await expectNoDocumentOverflow(page,testInfo);
  await expectCriticalTarget(page.getByTestId("calendar-add-appointment"));
  await page.getByTestId("calendar-add-appointment").click();
  await page.getByTestId("field-customerId").selectOption(tenant.customerId);
  await page.getByTestId("field-petId").selectOption(tenant.petId);
  await page.locator(`input[name="employeeIds"][value="${tenant.employeeId}"]`).check();
  await page.getByLabel("Full Groom").check();
  await page.getByTestId("field-startAt").fill(`${tenant.anchor}T09:00`);
  await page.getByTestId("modal-submit").scrollIntoViewIfNeeded();
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("calendar-list")).toContainText("Charlie");

  await page.reload();
  await expectAuthenticatedSurface(page);
  await openNavigation(page);
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar-list")).toContainText("Charlie");
  await expectNoDocumentOverflow(page,testInfo);
});

test("@responsive groomer day view remains contained and touch accessible",async({page,request,tenant},testInfo)=>{
  await createAppointment(request,tenant,{localStart:`${tenant.anchor}T09:00`});
  await login(page,tenant.ownerEmail);
  await openNavigation(page);
  await page.getByTestId("nav-calendar").click();
  await expectCriticalTarget(page.locator("#calendar-view-select"));
  await page.locator("#calendar-view-select").selectOption("day");
  await expect(page.locator(".day-groomer",{hasText:"Grace Groomer"})).toBeVisible();
  await expectCriticalTarget(page.locator(".day-slot").first());
  await expectNoDocumentOverflow(page,testInfo);
});

test("@responsive navigation forms dialogs and calendar controls remain reachable",async({page,tenant},testInfo)=>{
  await login(page,tenant.ownerEmail);
  await openNavigation(page);
  await expectNoDocumentOverflow(page,testInfo);
  for(const testId of ["nav-dashboard","nav-calendar","nav-customers"]) {
    await expectCriticalTarget(page.getByTestId(testId));
  }

  await page.getByTestId("nav-customers").click();
  await page.getByRole("button",{name:/\+ Pet/}).click();
  await expectDialogControlsReachable(page);
  await expectNoDocumentOverflow(page,testInfo);
  await page.getByTestId("modal").getByRole("button",{name:"Close"}).click();
  await expect(page.getByTestId("modal")).toBeHidden();

  await openNavigation(page);await page.getByTestId("nav-calendar").click();
  await page.getByTestId("calendar-add-appointment").click();
  await expectDialogControlsReachable(page);
  await expect(page.getByTestId("field-startAt")).toBeVisible();
  await page.getByTestId("modal").getByRole("button",{name:"Close"}).click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await expectNoDocumentOverflow(page,testInfo);
});
