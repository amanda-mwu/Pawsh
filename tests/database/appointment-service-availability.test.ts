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
  const createAppointment=(serviceIds:string[],localStart:string)=>app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{locationId,customerId,petId,employeeId,serviceIds,localStart,expectedLocationVersion:1}});

  it("books a service without a per-service groomer assignment",async()=>{
    const price=await app.inject({method:"POST",url:"/api/pricing/resolve",headers:{cookie:ownerCookie},payload:{petId,serviceIds:[addonId]}});
    expect(price.statusCode).toBe(200);expect(price.json()[0]).toMatchObject({name:"Test Paw Balm",status:"resolved",durationMinutes:15});
    const booking=await createAppointment([addonId],"2034-04-17T09:00");
    expect(booking.statusCode).toBe(201);
  });

  it("books multiple assigned services including an add-on and sums durations",async()=>{
    const booking=await createAppointment([primaryId,addonId],"2034-04-17T10:00");
    expect(booking.statusCode).toBe(201);
    const [stored]=await db<{minutes:number;count:number}[]>`select extract(epoch from (appointment.end_at-appointment.start_at))/60 minutes,count(service.id)::int count from appointments appointment join appointment_services service on service.appointment_id=appointment.id and service.business_id=appointment.business_id where appointment.business_id=${businessId} and appointment.id=${booking.json().id} group by appointment.id`;
    expect(Number(stored?.minutes)).toBe(45);expect(stored?.count).toBe(2);
  });

  it("assigns multiple groomers, blocks each groomer, and returns pet-specific defaults",async()=>{
    const booking=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{locationId,customerId,petId,employeeIds:[employeeId,secondEmployeeId],serviceIds:[primaryId],localStart:"2034-04-17T13:00",expectedLocationVersion:1}});
    expect(booking.statusCode).toBe(201);
    const assignments=await db<{employeeId:string}[]>`select employee_id from appointment_employees where business_id=${businessId} and appointment_id=${booking.json().id} order by employee_id`;
    expect(assignments.map(row=>row.employeeId).sort()).toEqual([employeeId,secondEmployeeId].sort());
    const conflict=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{locationId,customerId,petId,employeeIds:[secondEmployeeId],serviceIds:[primaryId],localStart:"2034-04-17T13:00",expectedLocationVersion:1}});
    expect(conflict.statusCode).toBe(409);
    const defaults=await app.inject({method:"GET",url:`/api/pets/${petId}/booking-defaults`,headers:{cookie:ownerCookie}});
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().groomers.map((item:{id:string})=>item.id).sort()).toEqual([employeeId,secondEmployeeId].sort());
    expect(defaults.json().services.map((item:{id:string})=>item.id)).toEqual([primaryId]);
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

  it("requires a groomer and rejects duplicate or cross-tenant groomer assignments",async()=>{
    const send=(employeeIds:string[])=>app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{locationId,customerId,petId,employeeIds,serviceIds:[primaryId],localStart:"2034-04-18T09:00",expectedLocationVersion:1}});
    expect((await send([])).statusCode).toBe(400);
    expect((await send([employeeId,employeeId])).statusCode).toBe(400);
    const foreign=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:`foreign-groomer-${crypto.randomUUID()}@example.test`,password:"correct horse foreign groomer",businessName:"Foreign Groomer"}});
    const foreignEmployee=await app.inject({method:"POST",url:"/api/employees",headers:{cookie:cookie(foreign)},payload:{displayName:"Wrong Tenant Groomer",serviceIds:[]}});
    const response=await send([foreignEmployee.json().id]);
    expect(response.statusCode).toBe(400);expect(response.json().error).toBe("One or more selected groomers are unavailable");
  });
});
