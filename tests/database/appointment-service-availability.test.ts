import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl=process.env.DATABASE_URL;
const describeDatabase=databaseUrl?describe:describe.skip;
const config:Config={NODE_ENV:"test",DOCUMENT_STORAGE_ADAPTER:"memory",PORT:3000,DATABASE_URL:databaseUrl??"postgres://unavailable",SESSION_SECRET:"appointment-service-test-secret-32-chars",APP_ORIGIN:"http://localhost:3000",SMTP_PORT:587,SMTP_SECURE:false};
const cookie=(response:{headers:Record<string,unknown>})=>String(response.headers["set-cookie"]).split(";",1)[0]!;

describeDatabase("appointment service availability",()=>{
  let db:Database,app:Awaited<ReturnType<typeof createApp>>;
  let ownerCookie:string,businessId:string,locationId:string,customerId:string,petId:string,employeeId:string,secondEmployeeId:string,primaryId:string,addonId:string;
  beforeAll(async()=>{
    db=createDatabase(config);app=await createApp(config,db,{runWorker:false,serveStatic:false});await app.ready();
    const signup=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:`booking-${crypto.randomUUID()}@example.test`,password:"correct horse booking battery",businessName:"Booking Availability"}});
    ownerCookie=cookie(signup);({businessId,locationId}=signup.json());
    const createService=async(name:string,duration:number,category:string)=>app.inject({method:"POST",url:"/api/services",headers:{cookie:ownerCookie},payload:{name,baseDurationMinutes:duration,basePriceMinor:1000,category,pricingMode:"FIXED",active:true}});
    primaryId=(await createService("Primary Groom",30,"GENERAL")).json().id;
    addonId=(await createService("Test Paw Balm",15,"A_LA_CARTE")).json().id;
    employeeId=(await app.inject({method:"POST",url:"/api/employees",headers:{cookie:ownerCookie},payload:{displayName:"Assigned Groomer",serviceIds:[primaryId]}})).json().id;
    secondEmployeeId=(await app.inject({method:"POST",url:"/api/employees",headers:{cookie:ownerCookie},payload:{displayName:"Second Groomer",serviceIds:[]}})).json().id;
    customerId=(await app.inject({method:"POST",url:"/api/customers",headers:{cookie:ownerCookie},payload:{firstName:"Booking",lastName:"Customer"}})).json().id;
    petId=(await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},payload:{customerId,name:"Booking Pet",species:"dog"}})).json().id;
  });
  afterAll(async()=>{await app.close();await db.end();});
  const createAppointment=(serviceIds:string[],localStart:string,groomerId:string=employeeId)=>app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{locationId,customerId,petId,employeeId:groomerId,serviceIds,localStart,expectedLocationVersion:1}});

  // `employee_services` is a per-groomer service restriction and an EMPTY set means unrestricted.
  // "Second Groomer" has no rows, so a service nobody was assigned to is bookable with them,
  // which is the property this test is about. "Assigned Groomer" is restricted to Primary Groom,
  // and asking them for the add-on is now refused rather than quietly allowed.
  it("books a service without a per-service groomer assignment",async()=>{
    const price=await app.inject({method:"POST",url:"/api/pricing/resolve",headers:{cookie:ownerCookie},payload:{petId,serviceIds:[addonId]}});
    expect(price.statusCode).toBe(200);expect(price.json()[0]).toMatchObject({name:"Test Paw Balm",status:"resolved",durationMinutes:15});
    const booking=await createAppointment([addonId],"2034-04-17T09:00",secondEmployeeId);
    expect(booking.statusCode).toBe(201);
    const restricted=await createAppointment([addonId],"2034-04-17T09:30",employeeId);
    expect(restricted.statusCode).toBe(409);
    expect(restricted.json()).toMatchObject({code:"EMPLOYEE_SERVICE_NOT_OFFERED",unsupportedServiceIds:[addonId]});
  });

  it("books multiple assigned services including an add-on and sums durations",async()=>{
    const booking=await createAppointment([primaryId,addonId],"2034-04-17T10:00",secondEmployeeId);
    expect(booking.statusCode).toBe(201);
    const [stored]=await db<{minutes:number;count:number}[]>`select extract(epoch from (appointment.end_at-appointment.start_at))/60 minutes,count(service.id)::int count from appointments appointment join appointment_services service on service.appointment_id=appointment.id and service.business_id=appointment.business_id where appointment.business_id=${businessId} and appointment.id=${booking.json().id} group by appointment.id`;
    expect(Number(stored?.minutes)).toBe(45);expect(stored?.count).toBe(2);
  });

  it("assigns exactly one groomer, rejects legacy arrays, and returns one pet-specific default",async()=>{
    const legacy=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{locationId,customerId,petId,employeeId,employeeIds:[employeeId,secondEmployeeId],serviceIds:[primaryId],localStart:"2034-04-17T13:00",expectedLocationVersion:1}});
    expect(legacy.statusCode).toBe(400);expect(JSON.stringify(legacy.json())).toContain("An appointment can only be assigned to one groomer.");
    const booking=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{locationId,customerId,petId,employeeId,serviceIds:[primaryId],localStart:"2034-04-17T13:00",expectedLocationVersion:1}});
    expect(booking.statusCode).toBe(201);
    const assignments=await db<{employeeId:string}[]>`select employee_id from appointment_employees where business_id=${businessId} and appointment_id=${booking.json().id} order by employee_id`;
    expect(assignments.map(row=>row.employeeId)).toEqual([employeeId]);
    await expect(db`insert into appointment_employees(business_id,appointment_id,employee_id) values (${businessId},${booking.json().id},${secondEmployeeId})`).rejects.toThrow();
    const legacyMove=await app.inject({method:"PATCH",url:`/api/appointments/${booking.json().id}/schedule`,headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{employeeId,employeeIds:[employeeId,secondEmployeeId],localStart:"2034-04-17T14:00",expectedLocationVersion:1,version:booking.json().version}});
    expect(legacyMove.statusCode).toBe(400);expect(JSON.stringify(legacyMove.json())).toContain("An appointment can only be assigned to one groomer.");
    const conflict=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{locationId,customerId,petId,employeeId,serviceIds:[primaryId],localStart:"2034-04-17T13:00",expectedLocationVersion:1}});
    expect(conflict.statusCode).toBe(409);
    const defaults=await app.inject({method:"GET",url:`/api/pets/${petId}/booking-defaults`,headers:{cookie:ownerCookie}});
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().groomers.map((item:{id:string})=>item.id)).toEqual([employeeId]);
    // The pet has visits but none of them were paid for, so there is no settled service
    // selection to carry forward and the endpoint says so instead of guessing.
    expect(defaults.json().services).toEqual([]);
    expect(defaults.json().serviceSource).toBe("none");
    expect(defaults.json().groomerSource).toBe("last_visit");
  });

  it("keeps multi-employee report filters while attributing an appointment to one groomer",async()=>{
    const booking=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},
      payload:{locationId,customerId,petId,employeeId,serviceIds:[primaryId],localStart:"2034-04-19T09:00",expectedLocationVersion:1}});
    expect(booking.statusCode).toBe(201);
    const sharedId=booking.json().id;
    for(const status of ["checked_in","in_service","completed"]){
      const moved=await app.inject({method:"POST",url:`/api/appointments/${sharedId}/transition`,headers:{cookie:ownerCookie},payload:{status}});
      expect(moved.statusCode,status).toBe(200);
    }
    const invoice=await app.inject({method:"POST",url:`/api/appointments/${sharedId}/checkout`,
      headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{discountMinor:0,tipMinor:0}});
    expect(invoice.statusCode).toBe(201);
    const totalMinor=invoice.json().totalMinor;
    const payment=await app.inject({method:"POST",url:`/api/invoices/${invoice.json().id}/payments`,
      headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},
      payload:{amountMinor:totalMinor,expectedBalanceMinor:totalMinor,method:"cash"}});
    expect(payment.statusCode).toBe(201);

    // Operational metrics bucket by appointment start (2034-04-19), so this window sees the
    // appointment but not the invoice, which was created today.
    const operational=(employeeIds:string)=>app.inject({method:"GET",
      url:`/api/reports?localDate=2034-04-19&days=1&employeeIds=${employeeIds}`,headers:{cookie:ownerCookie}});
    const first=await operational(employeeId);
    const second=await operational(secondEmployeeId);
    const both=await operational(`${employeeId},${secondEmployeeId}`);
    for(const response of [first,second,both])expect(response.statusCode).toBe(200);
    expect(first.json().totals).toMatchObject({completedAppointments:1,servicesPerformed:1});
    expect(second.json().totals).toMatchObject({completedAppointments:0,servicesPerformed:0});
    expect(both.json().totals).toEqual(first.json().totals);
    expect(both.json().totals.completedAppointments).toBe(1);
    expect(both.json().totals.servicesPerformed).toBe(1);

    const attribution=both.json().employees.filter((row:{appointmentCount:number})=>row.appointmentCount>0);
    expect(attribution.map((row:{id:string})=>row.id)).toEqual([employeeId]);
    const summed=attribution.reduce((total:number,row:{appointmentCount:number})=>total+row.appointmentCount,0);
    expect(summed).toBe(1);

    // Paid revenue buckets by invoice creation date, so it lands in the default (recent) window
    // and is likewise counted once when both groomers are selected.
    const revenueFor=(employeeIds:string)=>app.inject({method:"GET",
      url:`/api/reports?employeeIds=${employeeIds}`,headers:{cookie:ownerCookie}});
    const singleRevenue=await revenueFor(employeeId);
    const sharedRevenue=await revenueFor(`${employeeId},${secondEmployeeId}`);
    expect(singleRevenue.json().totals.paidRevenueMinor).toBe(totalMinor);
    expect(sharedRevenue.json().totals.paidRevenueMinor).toBe(totalMinor);
    expect(singleRevenue.json().totals.completedAppointments).toBe(0);
    expect(first.json().totals.paidRevenueMinor).toBe(0);
  });

  it("names an inactive service instead of reporting generic availability",async()=>{
    expect((await app.inject({method:"DELETE",url:`/api/services/${addonId}`,headers:{cookie:ownerCookie}})).statusCode).toBe(204);
    const booking=await createAppointment([addonId],"2034-04-17T12:00");
    expect(booking.statusCode).toBe(400);expect(booking.json().error).toBe("Test Paw Balm is inactive and cannot be booked.");
  });

  it("rejects missing duration and cross-tenant service identifiers",async()=>{
    const missingDuration=await app.inject({method:"POST",url:"/api/services",headers:{cookie:ownerCookie},payload:{name:"Missing duration",basePriceMinor:1000}});
    expect(missingDuration.statusCode).toBe(400);
    const foreign=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:`foreign-${crypto.randomUUID()}@example.test`,password:"correct horse foreign battery",businessName:"Foreign Booking"}});
    const foreignService=await app.inject({method:"POST",url:"/api/services",headers:{cookie:cookie(foreign)},payload:{name:"Foreign Service",baseDurationMinutes:20,basePriceMinor:1000}});
    const booking=await createAppointment([foreignService.json().id],"2034-04-17T11:00");
    expect(booking.statusCode).toBe(400);expect(booking.json().error).toBe("One or more selected services are unavailable");
  });

  it("requires one groomer and rejects legacy arrays or cross-tenant groomers",async()=>{
    const send=(assigned?:string,employeeIds?:string[])=>app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{locationId,customerId,petId,...(assigned?{employeeId:assigned}:{}),...(employeeIds?{employeeIds}:{}),serviceIds:[primaryId],localStart:"2034-04-18T09:00",expectedLocationVersion:1}});
    expect((await send()).statusCode).toBe(400);
    const multiple=await send(employeeId,[employeeId,secondEmployeeId]);expect(multiple.statusCode).toBe(400);expect(JSON.stringify(multiple.json())).toContain("An appointment can only be assigned to one groomer.");
    const foreign=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:`foreign-groomer-${crypto.randomUUID()}@example.test`,password:"correct horse foreign groomer",businessName:"Foreign Groomer"}});
    const foreignEmployee=await app.inject({method:"POST",url:"/api/employees",headers:{cookie:cookie(foreign)},payload:{displayName:"Wrong Tenant Groomer",serviceIds:[]}});
    const response=await send(foreignEmployee.json().id);
    expect(response.statusCode).toBe(400);expect(response.json().error).toBe("One or more selected groomers are unavailable");
  });

  // Declared last on purpose: paying an invoice moves business-wide revenue totals, and the
  // report assertions above measure exactly those totals for the shared tenant.
  it("carries default services forward only from the last paid visit",async()=>{
    const booking=await createAppointment([primaryId],"2034-04-21T09:00");
    expect(booking.statusCode).toBe(201);
    const paidId=booking.json().id;
    for(const status of ["checked_in","in_service","completed"]){
      const moved=await app.inject({method:"POST",url:`/api/appointments/${paidId}/transition`,headers:{cookie:ownerCookie},payload:{status}});
      expect(moved.statusCode,status).toBe(200);
    }
    const invoice=await app.inject({method:"POST",url:`/api/appointments/${paidId}/checkout`,
      headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{discountMinor:0,tipMinor:0}});
    expect(invoice.statusCode).toBe(201);
    const totalMinor=invoice.json().totalMinor;
    const payment=await app.inject({method:"POST",url:`/api/invoices/${invoice.json().id}/payments`,
      headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},
      payload:{amountMinor:totalMinor,expectedBalanceMinor:totalMinor,method:"cash"}});
    expect(payment.statusCode).toBe(201);

    const defaults=await app.inject({method:"GET",url:`/api/pets/${petId}/booking-defaults`,headers:{cookie:ownerCookie}});
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().services.map((item:{id:string})=>item.id)).toEqual([primaryId]);
    expect(defaults.json().serviceSource).toBe("last_paid_visit");
    // The groomer still reads from the most recent visit rather than the paid one, so a
    // later unpaid booking with a different groomer would move the groomer and not the services.
    expect(defaults.json().groomers.map((item:{id:string})=>item.id)).toEqual([employeeId]);
  });

});
