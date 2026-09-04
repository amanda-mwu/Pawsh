import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {createApp} from "../../src/app.js";
import type {Config} from "../../src/config.js";
import {createDatabase,type Database} from "../../src/db/client.js";
import {deliverNotifications,reconcileRabiesNotifications,type EmailMessage,type EmailProvider} from "../../src/engagement/worker.js";

const databaseUrl=process.env.DATABASE_URL;
const describeDatabase=databaseUrl?describe:describe.skip;
const config:Config={NODE_ENV:"test",DOCUMENT_STORAGE_ADAPTER:"memory",PORT:3000,
  DATABASE_URL:databaseUrl??"postgres://unavailable",SESSION_SECRET:"test-session-secret-at-least-thirty-two-characters",
  APP_ORIGIN:"http://localhost:3000",SMTP_PORT:587,SMTP_SECURE:false};
function cookie(response:{headers:Record<string,unknown>}){const value=response.headers["set-cookie"];
  if(typeof value!=="string")throw new Error("Session cookie missing");return value.split(";",1)[0]!;}

describeDatabase("rabies appointment compliance",()=>{
  let db:Database;let app:Awaited<ReturnType<typeof createApp>>;let ownerCookie:string;
  let businessId:string;let locationId:string;let customerId:string;let petId:string;let appointmentId:string;
  const suffix=crypto.randomUUID();const messages:EmailMessage[]=[];
  const provider:EmailProvider={async send(message){messages.push(message);return{providerReference:`test:${message.idempotencyKey}`};}};
  beforeAll(async()=>{
    db=createDatabase(config);app=await createApp(config,db,{runWorker:false,serveStatic:false});await app.ready();
    const signup=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:`rabies-owner-${suffix}@example.test`,password:"correct horse rabies battery",businessName:"Rabies Pilot",timezone:"America/Los_Angeles"}});
    ownerCookie=cookie(signup);({businessId,locationId}=signup.json());
    const customer=await app.inject({method:"POST",url:"/api/customers",headers:{cookie:ownerCookie},payload:{firstName:"Taylor",lastName:"Guardian",email:`guardian-${suffix}@example.test`,preferredContactMethod:"email",emailAllowed:true}});customerId=customer.json().id;
    const pet=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},payload:{customerId,name:"Maple",species:"dog"}});petId=pet.json().id;
    const service=await app.inject({method:"POST",url:"/api/services",headers:{cookie:ownerCookie},payload:{name:"Pilot groom",baseDurationMinutes:60,basePriceMinor:5000}});
    const employee=await app.inject({method:"POST",url:"/api/employees",headers:{cookie:ownerCookie},payload:{displayName:"Pilot Groomer",serviceIds:[service.json().id]}});
    const appointment=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{locationId,customerId,petId,employeeId:employee.json().id,localStart:"2032-08-11T10:00",expectedLocationVersion:1,serviceIds:[service.json().id]}});
    expect(appointment.statusCode).toBe(201);appointmentId=appointment.json().id;
  });
  afterAll(async()=>{await app.close();await db.end();});

  it("records expiration-only data with audit and no document",async()=>{
    const [pet]=await db<{version:number}[]>`select version from pets where id=${petId}`;
    const response=await app.inject({method:"PUT",url:`/api/pets/${petId}/care`,headers:{cookie:ownerCookie},payload:{
      vaccinationExpiresOn:"2032-08-10",version:pet!.version}});
    expect(response.statusCode).toBe(200);
    expect(String(response.json().vaccinationExpiresOn).slice(0,10)).toBe("2032-08-10");
    const [proof]=await db<{audits:number;documents:number;verifiedBy:string|null}[]>`
      select (select count(*)::int from audit_events where business_id=${businessId} and resource_id=${petId} and action='pet.care.update') audits,
        (select count(*)::int from pet_documents where business_id=${businessId} and pet_id=${petId}) documents,
        (select rabies_verified_by_membership_id from pets where business_id=${businessId} and id=${petId}) verified_by`;
    expect(proof).toMatchObject({audits:1,documents:0,verifiedBy:null});
    const [event]=await db<{count:number}[]>`select count(*)::int count from outbox_events
      where business_id=${businessId} and resource_id=${petId} and event_type='RabiesComplianceUpdated'`;
    expect(event!.count).toBe(1);
  });

  it("validates dates and derives appointment-local status",async()=>{
    const [pet]=await db<{version:number}[]>`select version from pets where id=${petId}`;
    const invalid=await app.inject({method:"PUT",url:`/api/pets/${petId}/care`,headers:{cookie:ownerCookie},payload:{rabiesVaccinationDate:"2032-09-01",vaccinationExpiresOn:"2032-08-01",version:pet!.version}});
    expect(invalid.statusCode).toBe(400);
    const list=await app.inject({method:"GET",url:"/api/appointments?localDate=2032-08-11&days=1",headers:{cookie:ownerCookie}});
    expect(list.statusCode).toBe(200);expect(list.json()[0]).toMatchObject({id:appointmentId,
      rabiesAppointmentStatus:"expires_before_appointment"});
    expect(String(list.json()[0].vaccinationExpiresOn).slice(0,10)).toBe("2032-08-10");
  });

  it("creates one durable customer notice and one owner warning and delivers without duplicates",async()=>{
    await reconcileRabiesNotifications(db,{businessId,appointmentId});
    await reconcileRabiesNotifications(db,{businessId,appointmentId});
    const intents=await db<{notificationType:string;status:string;recipientKind:string}[]>`
      select notification_type,status,recipient_kind from notification_intents
      where business_id=${businessId} and appointment_id=${appointmentId}
        and notification_type like 'rabies_%' order by recipient_kind`;
    expect(intents).toEqual([
      {notificationType:"rabies_expiration_customer",status:"pending",recipientKind:"customer"},
      {notificationType:"rabies_expiration_staff",status:"pending",recipientKind:"staff"}
    ]);
    // `deliverNotifications` is a GLOBAL, cross-tenant drain and it sends the oldest-due
    // notification first, which is correct and is not negotiable: a salon's reminder from an hour
    // ago outranks one created a second ago. These two intents are therefore the NEWEST thing in
    // the queue, and how many passes it takes to reach them is a fact about the rest of the run -
    // every other suite that leaves an undelivered intent behind adds one. Two fixed passes only
    // ever worked while the queue happened to be shallower than fifty, and which of two tied rows
    // went first used to be arbitrary, so this read as an intermittent failure rather than as the
    // coupling it is. Drain until these two have left the queue, THEN take the extra pass: the
    // duplicate check this test exists for is that the extra pass sends nothing a second time.
    const stillQueued=async()=>{
      const [row]=await db<{count:number}[]>`select count(*)::int count from notification_intents
        where business_id=${businessId} and appointment_id=${appointmentId}
          and notification_type like 'rabies_%' and status in ('pending','failed')`;
      return row!.count;
    };
    for(let pass=0;pass<20 && await stillQueued()>0;pass+=1) {
      expect(await deliverNotifications(db,provider),`pass ${pass} claimed nothing`).toBeGreaterThan(0);
    }
    expect(await stillQueued()).toBe(0);
    await deliverNotifications(db,provider);
    const rabiesMessages=messages.filter(message=>/rabies/i.test(message.subject));
    expect(rabiesMessages).toHaveLength(2);
    expect(rabiesMessages.find(message=>message.subject.includes("Updated rabies"))?.text)
      .toContain("Maple");
    expect(rabiesMessages.find(message=>message.subject.includes("needs attention"))?.text)
      .toContain("Customer notification status");
  });

  it("resolves pending warnings when renewed data becomes valid",async()=>{
    await db`update notification_intents set status='pending',provider_message_id=null where appointment_id=${appointmentId} and notification_type like 'rabies_%'`;
    const [pet]=await db<{version:number}[]>`select version from pets where id=${petId}`;
    const update=await app.inject({method:"PUT",url:`/api/pets/${petId}/care`,headers:{cookie:ownerCookie},payload:{vaccinationExpiresOn:"2033-08-10",version:pet!.version}});
    expect(update.statusCode).toBe(200);
    const [count]=await db<{active:number}[]>`select count(*)::int active from notification_intents where appointment_id=${appointmentId} and notification_type like 'rabies_%' and status in ('pending','failed','suppressed')`;
    expect(count!.active).toBe(0);
    await reconcileRabiesNotifications(db,{businessId,appointmentId});
    const list=await app.inject({method:"GET",url:"/api/appointments?localDate=2032-08-11&days=1",headers:{cookie:ownerCookie}});
    expect(list.json()[0].rabiesAppointmentStatus).toBe("valid_for_appointment");
  });
});
