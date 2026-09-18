import { test, expect, login } from "../fixtures/tenant.js";
import { bookAppointment, chooseBookingClient, openBooking } from "../helpers/booking.js";

test("@smoke CRM search persists and booking filters pets by customer",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await page.getByTestId("new-customer").click();
  await page.getByTestId("field-firstName").fill("Smoke");
  await page.getByTestId("field-lastName").fill("Searchable");
  await page.getByTestId("field-email").fill(`search+${tenant.runId}@pawsh-test.example`);
  await page.getByTestId("field-phone").fill("626-555-0199");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await page.getByTestId("customer-search").fill("6265550199");
  await expect(page.getByTestId("customer-card")).toHaveCount(1);
  await expect(page.getByTestId("customer-card")).toContainText("Smoke Searchable");
  await page.getByTestId("customer-search").fill(`search+${tenant.runId}`);
  await expect(page.getByTestId("customer-card")).toHaveCount(1);
  await expect(page.getByTestId("customer-card")).toContainText("Smoke Searchable");
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await openBooking(page);
  await chooseBookingClient(page,tenant.sophiaCustomerId);
  await page.getByTestId("booking-add-pet").click();
  const petOptions=page.getByTestId("booking-pet-options");
  await expect(petOptions.getByText("Mochi",{exact:true})).toHaveCount(1);
  await expect(petOptions.getByText("Boba",{exact:true})).toHaveCount(1);
  await expect(page.locator(`input[name="bookingPet"][value="${tenant.petId}"]`)).toHaveCount(0);
});

test("@smoke scheduling lets the owner overlap, refuses blocked time, and permits adjacency",async({page,request,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  const createAt=(time:string)=>bookAppointment(page,{
    customerId:tenant.customerId,petId:tenant.petId,employeeId:tenant.employeeId,
    startAt:`${tenant.anchor}T${time}`
  });
  await createAt("09:00");
  await expect(page.getByTestId("calendar-list")).toContainText("Charlie");
  // AN OWNER BOOKS OVER ANOTHER APPOINTMENT WITHOUT BEING ASKED. Overlap used to be a 409 that
  // named the clash and, for this role, offered "Book anyway"; the rule now is that a role holding
  // appointments.override_conflict simply books, and the overlap is recorded on the audit trail.
  // A groomer still gets the refusal - that case lives in the scheduling specs.
  await createAt("09:30");
  await expect(page.getByTestId("calendar-list").getByText("Charlie")).toHaveCount(2);
  await createAt("10:30");
  await expect(page.getByTestId("calendar-list").getByText("Charlie")).toHaveCount(3);
  await request.post("/api/blocked-times",{data:{
    employeeId:tenant.employeeId,locationId:tenant.locationId,localStart:`${tenant.anchor}T13:00`,
    localEnd:`${tenant.anchor}T14:00`,expectedLocationVersion:tenant.locationVersion,reason:"Smoke blocked time"
  }});
  await createAt("13:00");
  // The refusal names WHICH restriction stopped it. It used to be one 400 reading "outside
  // employee availability; an explicit override is required" for a blocked time, a groomer's
  // hours, the salon's hours and a per-date unavailability alike; those are four different things
  // to go and fix, so they are four codes and four sentences now. This one is `TIME_BLOCKED`.
  await expect(page.locator("#booking-error"))
    .toContainText(`has time blocked out during that time on ${tenant.anchor}`);
});
