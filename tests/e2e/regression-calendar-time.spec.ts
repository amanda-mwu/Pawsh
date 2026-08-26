import { createAppointment, expect, login, test } from "./fixtures/tenant.js";
import { chooseBookingClient, chooseBookingPet, openSlotAction } from "./helpers/booking.js";

test("@regression-calendar-time keeps Los Angeles scheduling intent in a New York browser", async ({browser,request,tenant}) => {
  const localStart=`${tenant.anchor}T09:00`;
  const created=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{
    locationId:tenant.locationId,customerId:tenant.customerId,petId:tenant.petId,employeeId:tenant.employeeId,
    serviceIds:[tenant.serviceId],localStart,expectedLocationVersion:tenant.locationVersion
  }});
  expect(created.status()).toBe(201);
  expect((await created.json()).scheduledLocalStart).toContain(localStart);
  const context=await browser.newContext({baseURL:process.env.PAWSH_E2E_BASE_URL??"http://127.0.0.1:3000",timezoneId:"America/New_York"});
  const page=await context.newPage();
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar-list").locator(".week-time",{hasText:"9:00 AM"})).toBeVisible();
  await context.close();
});

test("@regression-calendar-time rejects nonexistent time and preserves both repeated occurrences", async ({request,tenant}) => {
  const base={locationId:tenant.locationId,customerId:tenant.customerId,petId:tenant.petId,employeeId:tenant.employeeId,
    serviceIds:[tenant.serviceId],expectedLocationVersion:tenant.locationVersion,availabilityOverride:true,overrideConflict:true,overrideReason:"DST regression"};
  const missing=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{...base,localStart:"2026-03-08T02:30"}});
  expect(missing.status()).toBe(400);
  expect((await missing.json()).code).toBe("NONEXISTENT_LOCAL_TIME");
  const ambiguous=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{...base,localStart:"2026-11-01T01:30"}});
  expect(ambiguous.status()).toBe(400);
  expect((await ambiguous.json()).code).toBe("AMBIGUOUS_LOCAL_TIME");
  const earlier=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{...base,localStart:"2026-11-01T01:30",disambiguation:"earlier"}});
  const later=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{...base,localStart:"2026-11-01T01:30",disambiguation:"later"}});
  expect(earlier.status()).toBe(201);
  expect(later.status()).toBe(201);
  expect(new Date((await later.json()).startAt).getTime()-new Date((await earlier.json()).startAt).getTime()).toBe(3_600_000);
});

test("@regression-calendar-time synchronizes week navigation and preselects an empty slot",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);await page.getByTestId("nav-calendar").click();
  await expect(page.locator(".month-sidebar")).toHaveCount(0);await expect(page.locator(".week-day-head")).toHaveCount(7);
  const initial=await page.locator("#calendar-range").textContent();await page.locator("#calendar-next-week").click();await expect(page.locator("#calendar-range")).not.toHaveText(initial??"");
  const nextRange=await page.locator("#calendar-range").textContent();await page.locator("#calendar-today").click();await expect(page.locator("#calendar-range")).not.toHaveText(nextRange??"");
  const slot=page.locator('.week-slot:not(.closed)').first();const preset=await slot.getAttribute("data-slot");
  await slot.click();
  // The slot offers Add or Block before committing to either; Add carries the slot's own time.
  await expect(page.getByTestId("slot-menu")).toBeVisible();
  await page.getByTestId("slot-menu-add").click();
  await chooseBookingClient(page,tenant.customerId);
  await expect(page.locator('#booking-dialog [name="startAt"]')).toHaveValue(preset??"");
  await page.getByTestId("booking-dialog").getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(page.getByTestId("booking-dialog")).toBeHidden();
  // Block starts from the same slot rather than making someone retype the time they clicked.
  await slot.click();
  await page.getByTestId("slot-menu-block").click();
  await expect(page.getByTestId("field-startAt")).toHaveValue(preset??"");
  await page.getByTestId("modal").getByRole("button",{name:"Cancel",exact:true}).click();
});

test("@cross-browser @regression-calendar-time provides bounded print preview and view-only calendar settings",async({page,request,tenant})=>{
  await createAppointment(request,tenant,{localStart:`${tenant.anchor}T09:00`});
  await login(page,tenant.ownerEmail);await page.getByTestId("nav-calendar").click();await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("print-agenda")).toHaveAccessibleName("Print agenda");await page.getByTestId("print-agenda").click();
  const dialog=page.getByTestId("modal");await expect(dialog.getByRole("heading",{name:"Print agenda"})).toBeVisible();await expect(dialog.locator("#print-agenda-preview")).toContainText("Charlie");await expect(dialog.locator("#print-agenda-preview")).toContainText("Emma Johnson");await expect(dialog.locator("#print-agenda-preview")).toContainText("Full Groom");await dialog.getByRole("button",{name:"Close"}).last().click();
  const before=await request.get("/api/business/working-hours");expect(before.status()).toBe(200);const authoritative=await before.json();
  await page.getByTestId("calendar-settings").click();await expect(dialog.getByRole("heading",{name:"Calendar settings"})).toBeVisible();await dialog.locator('select[name="firstDay"]').selectOption("monday");await dialog.locator('select[name="density"]').selectOption("compact");await dialog.getByRole("button",{name:"Apply changes"}).click();await expect(dialog).toBeHidden();
  await expect(page.locator("#calendar")).toHaveAttribute("data-calendar-density","compact");await page.locator("#calendar-view-select").selectOption("month");await expect(page.locator(".calendar-month-weekday").first()).toHaveText("Mon");
  expect(await (await request.get("/api/business/working-hours")).json()).toEqual(authoritative);
});

test("@cross-browser @regression-calendar-time exposes on-demand appointment actions and one compact rabies warning",async({page,request,tenant})=>{
  const appointment=await createAppointment(request,tenant,{localStart:`${tenant.anchor}T09:00`});
  const laterAppointment=await createAppointment(request,tenant,{localStart:`${tenant.anchor}T11:00`});
  await login(page,tenant.ownerEmail);await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  const card=page.locator(`.week-appointment[data-appointment-id="${appointment.id}"]`);
  await expect(card.locator('.card-warning[aria-label="Rabies needed"]')).toHaveCount(1);
  await expect(card.locator(".appointment-card-footer")).toHaveCount(0);
  await expect(card.locator(".appointment-pet")).toHaveText("Charlie");
  await expect(card.locator(".appointment-breed")).toHaveText("Golden Retriever");
  await card.locator(".calendar-open").hover();const hover=page.locator("#calendar-hover-preview");await expect(hover).toBeVisible();await expect(hover).toHaveCSS("pointer-events","none");await expect(hover).toContainText("Emma Johnson");await expect(hover).toContainText("Charlie");await expect(hover).toContainText("Grace Groomer");await expect(hover).toContainText("Full Groom");await expect(hover).toContainText("90 min");const hoverBox=await hover.boundingBox();expect(hoverBox).not.toBeNull();expect(hoverBox!.x).toBeGreaterThanOrEqual(0);expect(hoverBox!.x+hoverBox!.width).toBeLessThanOrEqual(await page.evaluate(()=>innerWidth));
  const laterCard=page.locator(`.week-appointment[data-appointment-id="${laterAppointment.id}"]`);await laterCard.locator(".calendar-open").hover();await expect(hover).toHaveAttribute("data-hover-appointment-id",laterAppointment.id);await page.mouse.move(0,0);await expect(hover).toBeHidden();await expect(page.locator("#calendar-hover-preview")).toHaveCount(1);
  await expect(card.getByRole("menuitem",{name:"Check in"})).toBeHidden();
  const trigger=card.getByRole("button",{name:/Appointment actions for/}).filter({visible:true});await expect(trigger).toBeVisible();await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded","true");
  await expect(card.getByRole("menuitem",{name:"Check in"})).toBeVisible();
  await expect(card.getByRole("menuitem",{name:"View / Edit"})).toBeVisible();
  await expect(card.getByRole("menuitem",{name:"Move"})).toBeVisible();
  await expect(card.getByRole("menuitem",{name:"Cancel appointment"})).toBeVisible();
  await expect(card.getByRole("menuitem",{name:"No show"})).toBeVisible();
  await expect(card.locator("select")).toHaveCount(0);
  await expect(page.locator(".month-sidebar")).toHaveCount(0);
  await page.locator("#calendar-agenda-mode").click();await expect(page.locator(".calendar-agenda")).toBeVisible();await expect(page.locator("#calendar-view-control")).toBeHidden();await expect(page.locator(".agenda-day")).toHaveCount(1);await expect(page.locator(".agenda-entry")).toHaveCount(2);expect((await page.locator(".agenda-entry").first().boundingBox())!.height).toBeLessThan(100);
  await page.locator("#calendar-calendar-mode").click();await expect(page.locator("#calendar-view-control")).toBeVisible();
  const laterTrigger=page.locator(`.week-appointment[data-appointment-id="${laterAppointment.id}"]`).getByRole("button",{name:/Appointment actions for/});await laterTrigger.focus();await laterTrigger.press("Enter");await expect(trigger).toHaveAttribute("aria-expanded","false");await expect(laterTrigger).toHaveAttribute("aria-expanded","true");
  await page.keyboard.press("Escape");await expect(laterTrigger).toHaveAttribute("aria-expanded","false");await expect(laterTrigger).toBeFocused();
  await trigger.click();
  await page.locator("#calendar-range").click();await expect(trigger).toHaveAttribute("aria-expanded","false");
  const open=card.locator(".calendar-open");await open.click();const detail=page.getByTestId("appointment-detail");await expect(detail).toBeVisible();await expect(page.getByRole("button",{name:"Close appointment details"})).toBeVisible();await expect(detail).toContainText("Emma Johnson");await expect(detail).toContainText("Charlie");await expect(detail).toContainText("Grace Groomer");await expect(detail).toContainText("Full Groom");await expect(detail).toContainText("90 min");await expect(detail.getByText("Grace Groomer",{exact:true})).toHaveCount(1);await page.getByRole("button",{name:"Close appointment details"}).click();await expect(detail).toBeHidden();await expect(page.getByTestId("calendar")).toBeVisible();await expect(page.locator("#calendar-view-select")).toHaveValue("week");await expect(open).toBeFocused();
  await open.click();await page.keyboard.press("Escape");await expect(detail).toBeHidden();await expect(open).toBeFocused();
  await open.click();await detail.getByRole("button",{name:"View client"}).click();await expect(page.getByTestId("client-profile-view")).toBeVisible();await page.locator(".client-profile-back").click();await expect(page.getByTestId("calendar")).toBeVisible();await expect(page.locator("#calendar-view-select")).toHaveValue("week");
});

test("@cross-browser @regression-calendar-time month view and applied groomer filter share calendar state",async({page,request,tenant})=>{
  const employeeResponse=await request.post("/api/employees",{data:{displayName:"Filter Groomer",serviceIds:[tenant.serviceId]}});expect(employeeResponse.status()).toBe(201);const second=await employeeResponse.json() as {id:string};
  await login(page,tenant.ownerEmail);await page.getByTestId("nav-calendar").click();await page.waitForLoadState("networkidle");
  await page.locator("#groomer-filter-trigger").click();await expect(page.locator("#groomer-filter")).toHaveAttribute("open","");
  await page.locator("#groomer-deselect-all").click();await page.locator(`#groomer-filter-options input[value="${second.id}"]`).check();await page.locator("#groomer-filter-apply").click();
  await expect(page.locator("#groomer-filter-trigger")).toContainText("1 groomer");
  await page.reload();await page.getByTestId("nav-calendar").click();await expect(page.locator("#groomer-filter-trigger")).toContainText("1 groomer");
  await page.locator("#calendar-view-select").selectOption("day");await expect(page.locator(".day-groomer")).toHaveCount(1);await expect(page.locator(".day-groomer")).toContainText("Filter Groomer");
  await page.locator("#calendar-view-select").selectOption("month");await expect(page.locator(".calendar-month-day")).toHaveCount(42);await expect(page.locator(".calendar-month-weekday")).toHaveCount(7);
  await page.locator("#groomer-filter-trigger").click();await page.locator("#groomer-deselect-all").click();await page.locator("#groomer-filter-apply").click();await page.locator("#calendar-view-select").selectOption("day");await expect(page.locator(".calendar-empty-groomers")).toContainText("No groomers selected");
});

test("@cross-browser @regression-calendar-time renders groomer day lanes and preserves slot click intent near an appointment",async({page,request,tenant})=>{
  const employeeResponse=await request.post("/api/employees",{data:{displayName:"Alex Groomer",serviceIds:[tenant.serviceId]}});
  expect(employeeResponse.status()).toBe(201);const secondEmployee=await employeeResponse.json() as {id:string};
  const inactiveResponse=await request.post("/api/employees",{data:{displayName:"Inactive Groomer",serviceIds:[tenant.serviceId]}});
  expect(inactiveResponse.status()).toBe(201);const inactiveEmployee=await inactiveResponse.json() as {id:string};
  expect((await request.delete(`/api/employees/${inactiveEmployee.id}`)).status()).toBe(204);
  expect((await request.put(`/api/employees/${secondEmployee.id}/working-hours`,{data:{hours:[1,2,3,4,5].map(weekday=>({weekday,startTime:"08:00",endTime:"18:00"}))}})).status()).toBe(204);
  const appointmentResponse=await request.post("/api/appointments",{headers:{"Idempotency-Key":crypto.randomUUID()},data:{locationId:tenant.locationId,customerId:tenant.customerId,petId:tenant.petId,employeeId:tenant.employeeId,serviceIds:[tenant.serviceId],localStart:`${tenant.anchor}T09:00`,expectedLocationVersion:tenant.locationVersion}});
  expect(appointmentResponse.status()).toBe(201);const appointment=await appointmentResponse.json() as {id:string};
  await login(page,tenant.ownerEmail);await page.getByTestId("nav-calendar").click();
  await page.locator("#calendar-view-select").selectOption("day");
  await expect(page.locator("#calendar-view-select")).toHaveValue("day");
  await expect(page.locator(".day-corner")).toHaveText("Time");
  await expect(page.locator(".day-groomer",{hasText:"Grace Groomer"})).toBeVisible();
  await expect(page.locator(".day-groomer",{hasText:"Inactive Groomer"})).toHaveCount(0);
  await expect(page.locator(`.day-appointment[data-appointment-id="${appointment.id}"]`)).toHaveCount(1);
  await page.locator(`.day-appointment[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();
  await expect(page.getByTestId("appointment-detail")).toBeVisible();await page.getByRole("button",{name:"Close appointment details"}).click();await expect(page.getByTestId("calendar")).toBeVisible();
  // An empty slot offers Add or Block before it commits to either, and Add carries the slot's
  // own time and groomer column into the workspace.
  await openSlotAction(page,{slot:`${tenant.anchor}T10:30`,groomerId:tenant.employeeId,action:"add"});
  await chooseBookingClient(page,tenant.customerId);
  await expect(page.locator('#booking-dialog [name="startAt"]')).toHaveValue(`${tenant.anchor}T10:30`);
  await expect(page.locator('#booking-dialog select[name="employeeId"]')).toHaveValue(tenant.employeeId);
  await page.getByTestId("booking-dialog").getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(page.getByTestId("booking-dialog")).toBeHidden();
  await openSlotAction(page,{slot:`${tenant.anchor}T11:00`,groomerId:secondEmployee.id,action:"add"});
  await chooseBookingClient(page,tenant.customerId);
  await chooseBookingPet(page,tenant.petId);
  // The slot's own groomer outranks the pet's last groomer, and an unpaid prior visit
  // contributes no services.
  await expect(page.locator('#booking-dialog select[name="employeeId"]')).toHaveValue(secondEmployee.id);
  await expect(page.locator(`#booking-dialog input[name="serviceIds"][value="${tenant.serviceId}"]`)).not.toBeChecked();
});
