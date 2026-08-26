import {
  test,
  expect,
  login,
  prepareReceipt,
} from "../fixtures/tenant.js";
import { bookAppointment, chooseBookingClient, openBooking } from "../helpers/booking.js";

test("@cross-browser auth lifecycle preserves and revokes the browser session",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);

  const authenticatedStatus=await page.evaluate(async()=>{
    const response=await fetch("/api/me",{credentials:"include"});
    return response.status;
  });
  expect(authenticatedStatus).toBe(200);

  await page.reload();
  await expect(page.getByTestId("dashboard")).toBeVisible();

  await page.getByTestId("account-trigger").click();
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("auth-form")).toBeVisible();
  const loggedOutStatus=await page.evaluate(async()=>{
    const response=await fetch("/api/me",{credentials:"include"});
    return response.status;
  });
  expect(loggedOutStatus).toBe(401);
});

test("@cross-browser calendar booking remains visible after reload",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await bookAppointment(page,{
    customerId:tenant.customerId,petId:tenant.petId,employeeId:tenant.employeeId,
    startAt:`${tenant.anchor}T09:00`
  });

  await expect(page.getByTestId("calendar-list")).toContainText("Charlie");
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar-list")).toContainText("Charlie");
});

test("@cross-browser customer and pet creation remains customer-scoped",async({page,tenant})=>{
  const customerName=`Browser ${tenant.runId.slice(-8)}`;
  const petName=`Pixel ${tenant.runId.slice(-6)}`;
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();

  await page.getByTestId("new-customer").click();
  await page.getByTestId("field-firstName").fill("Browser");
  await page.getByTestId("field-lastName").fill(tenant.runId.slice(-8));
  await page.getByTestId("field-email").fill(`browser+${tenant.runId}@pawsh-test.example`);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("customer-card").filter({hasText:customerName})).toBeVisible();

  await page.getByRole("button",{name:/\+ Pet/}).click();
  const customerOption=page.getByTestId("field-customerId").locator("option",{hasText:customerName});
  const customerId=await customerOption.getAttribute("value");
  expect(customerId).toBeTruthy();
  await page.getByTestId("field-customerId").selectOption(customerId!);
  await page.getByTestId("field-name").fill(petName);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("customer-card").filter({hasText:customerName})).toContainText(petName);

  await page.getByTestId("nav-calendar").click();
  await openBooking(page);
  await chooseBookingClient(page,customerId!);
  await page.getByTestId("booking-add-pet").click();
  await expect(page.getByTestId("booking-pet-options").getByText(petName,{exact:true})).toHaveCount(1);
  await expect(page.locator(`input[name="bookingPet"][value="${tenant.petId}"]`)).toHaveCount(0);
});

test("@cross-browser completed checkout receipt renders prepared totals",async({page,request,tenant})=>{
  await prepareReceipt(request,tenant);
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  const customer=page.getByTestId("customer-card").filter({hasText:"Emma Johnson"});
  await customer.getByTestId("client-row-actions").click();
  await customer.getByTestId("client-appointment-history").click();
  await page.getByRole("button",{name:"Receipt"}).click();

  const receipt=page.getByTestId("receipt");
  await expect(receipt).toContainText("Subtotal$85.00");
  await expect(receipt).toContainText("Discount-$5.00");
  await expect(receipt).toContainText("Tax$6.60");
  await expect(receipt).toContainText("Tip$15.00");
  await expect(receipt).toContainText("Total$101.60");
  await expect(receipt).toContainText("Balance$0.00");
});
