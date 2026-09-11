import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { roleFor } from "../support/roles.js";
import { hashPassword } from "../../src/security/passwords.js";
import { tokenHash } from "../../src/http/context.js";

/**
 * "READY FOR PICKUP" IS A BUTTON, NOT A STATE.
 *
 * The operator action says the work is finished and the pet can go home. What it writes is the
 * existing `completed` status - no new enum value, no `ready_at` column, no fourth lifecycle
 * state - through the transition route that every other lifecycle action already uses, with its
 * permission, its row lock, its version check and its clock stamp intact.
 *
 * `checked_in -> completed` became a legal edge for it. That is a real widening of the transition
 * table and is asserted here against the SERVER rather than against the table, because the table
 * agreeing with itself proves nothing about what the route will accept.
 *
 * THE TWO THINGS IT MUST NOT DO, and both are absences:
 *
 *   IT MUST NOT TOUCH MONEY. `completed` does not mean paid. Marking a pet ready raises no
 *       invoice, records no payment, and leaves a bill that already exists exactly as it was.
 *   IT MUST NOT REPLACE `in_service`. The longer path is unchanged and still ends in the same
 *       place, so a salon that marks work started keeps every stamp it had.
 *
 * --- WHAT A MUTATION HAS TO BREAK --------------------------------------------------------------
 *
 *   `checked_in: ["in_service", "completed"]` -> `["in_service"]`
 *       "marks a checked-in visit ready for pickup" fails.
 *
 *   `checked_in: [...]` gains `no_show` or `cancelled`
 *       "refuses the edges that were never added" fails.
 *
 *   the checkout handler given an `update appointments set status=...`
 *       "billing a visit leaves it where it stands" fails.
 *
 *   Ready for Pickup wired to anything that writes money
 *       "marking a pet ready records no money at all" fails.
 *
 *   `operations.complete` dropped from the transition route's permission ladder
 *       "requires the permission that finishing work has always required" fails.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV:"test",DOCUMENT_STORAGE_ADAPTER:"memory",PORT:3000,
  DATABASE_URL:databaseUrl??"postgres://unavailable",
  SESSION_SECRET:"test-session-secret-at-least-thirty-two-characters",
  APP_ORIGIN:"http://localhost:3000",SMTP_PORT:587,SMTP_SECURE:false
};

function cookie(response:{headers:Record<string,unknown>}):string{
  const value=response.headers["set-cookie"];
  if(typeof value!=="string")throw new Error("Session cookie missing");
  return value.split(";",1)[0]!;
}

describeDatabase("ready for pickup",()=>{
  let db:Database;
  let app:Awaited<ReturnType<typeof createApp>>;
  let ownerCookie="",noCompleteCookie="",businessId="",locationId="",employeeId="",serviceId="",customerId="",petId="";
  const suffix=crypto.randomUUID();
  const key=():string=>crypto.randomUUID();

  let day=1;
  async function checkedIn(){
    const at=`2035-08-${String(++day).padStart(2,"0")}`;
    const [appointment]=await db<{id:string;version:number}[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,checked_in_at,created_by,updated_by)
      select ${businessId},${locationId},${customerId},${petId},${employeeId},
        ${`${at}T16:00:00.000Z`}::timestamptz,${`${at}T17:00:00.000Z`}::timestamptz,'America/Los_Angeles',
        ${`${at}T16:00:00.000Z`}::timestamptz at time zone 'America/Los_Angeles',-420,'checked_in',
        now()-interval '1 hour',user_id,user_id
      from business_memberships where business_id=${businessId} and is_owner returning id,version
    `;
    await db`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
        duration_minutes_snapshot,price_minor_snapshot,line_position)
      values (${businessId},${appointment!.id},${serviceId},'Pickup Groom Snapshot',60,8500,1)
    `;
    return appointment!;
  }

  async function transition(appointmentId:string,status:string,version:number,session=ownerCookie){
    return app.inject({method:"POST",url:`/api/appointments/${appointmentId}/transition`,
      headers:{cookie:session},payload:{status,version}});
  }

  async function row(appointmentId:string){
    const [record]=await db<{status:string;checkedInAt:Date|null;checkedOutAt:Date|null}[]>`
      select status,checked_in_at,checked_out_at from appointments
      where business_id=${businessId} and id=${appointmentId}`;
    return record!;
  }

  /** Everything financial this appointment produced, which for Ready for Pickup must be nothing. */
  async function financialFootprint(appointmentId:string){
    const [counts]=await db<{invoices:number;payments:number}[]>`
      select
        (select count(*)::integer from invoices where business_id=${businessId} and appointment_id=${appointmentId}) invoices,
        (select count(*)::integer from payments p join invoices i on i.id=p.invoice_id and i.business_id=p.business_id
          where p.business_id=${businessId} and i.appointment_id=${appointmentId}) payments
    `;
    return counts!;
  }

  beforeAll(async()=>{
    db=createDatabase(config);
    app=await createApp(config,db,{runWorker:false,serveStatic:false});
    await app.ready();
    const signup=await app.inject({method:"POST",url:"/api/auth/signup",payload:{
      email:`pickup-owner-${suffix}@example.test`,password:"correct horse ready for pickup",
      businessName:"Pickup Grooming"
    }});
    ownerCookie=cookie(signup);({businessId,locationId}=signup.json());
    await app.inject({method:"PUT",url:"/api/business/settings",headers:{cookie:ownerCookie},payload:{
      name:"Pickup Grooming",timezone:"America/Los_Angeles",currency:"USD",
      taxRateBasisPoints:0,reminderLeadMinutes:1440,locationVersion:1
    }});
    serviceId=(await app.inject({method:"POST",url:"/api/services",headers:{cookie:ownerCookie},
      payload:{name:"Pickup Groom",baseDurationMinutes:60,basePriceMinor:8500}})).json().id;
    employeeId=(await app.inject({method:"POST",url:"/api/employees",headers:{cookie:ownerCookie},
      payload:{displayName:"Pickup Groomer",serviceIds:[serviceId]}})).json().id;
    customerId=(await app.inject({method:"POST",url:"/api/customers",headers:{cookie:ownerCookie},
      payload:{firstName:"Pia",lastName:"Novak",preferredContactMethod:"none"}})).json().id;
    petId=(await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},
      payload:{customerId,name:"Biscuit",species:"dog"}})).json().id;

    // A member who may check in and take money but may NOT say the work is finished.
    const passwordHash=await hashPassword("correct horse pickup member");
    const token=crypto.randomUUID();
    const [member]=await db<{userId:string}[]>`
      with account as (
        insert into users(email,normalized_email,password_hash) values
          (${`pickup-member-${suffix}@example.test`},${`pickup-member-${suffix}@example.test`},${passwordHash}) returning id
      )
      insert into business_memberships(business_id,user_id,role_id)
      select ${businessId},id,${await roleFor(db,businessId,["operations.check_in","checkout.perform","payments.view"])}
      from account returning user_id
    `;
    await db`insert into sessions(user_id,token_hash,expires_at) values (${member!.userId},${tokenHash(token)},now()+interval '1 day')`;
    noCompleteCookie=`pawsh_session=${token}`;
  });
  afterAll(async()=>{await app.close();await db.end();});

  it("marks a checked-in visit ready for pickup, and stamps the clock",async()=>{
    const appointment=await checkedIn();
    const response=await transition(appointment.id,"completed",appointment.version);
    expect(response.statusCode,response.body).toBe(200);

    const after=await row(appointment.id);
    expect(after.status).toBe("completed");
    // The check-in stamp it arrived with is untouched, and the check-out stamp is written by the
    // same statement as the status - so a completed visit can never be missing its end time.
    expect(after.checkedInAt).not.toBeNull();
    expect(after.checkedOutAt).not.toBeNull();
    expect(after.checkedOutAt!.getTime()).toBeGreaterThanOrEqual(after.checkedInAt!.getTime());
  });

  it("marking a pet ready records no money at all",async()=>{
    const appointment=await checkedIn();
    expect((await transition(appointment.id,"completed",appointment.version)).statusCode).toBe(200);
    expect(await financialFootprint(appointment.id)).toEqual({invoices:0,payments:0});
  });

  it("leaves a bill already raised exactly as it was",async()=>{
    // Billed at drop-off, then handed back. The invoice must neither be re-raised nor disturbed.
    const appointment=await checkedIn();
    const invoice=await app.inject({method:"POST",url:`/api/appointments/${appointment.id}/checkout`,
      headers:{cookie:ownerCookie,"idempotency-key":key()},
      payload:{discountMinor:0,discountType:null,tipMinor:0}});
    expect(invoice.statusCode).toBe(201);

    const [current]=await db<{version:number}[]>`
      select version from appointments where business_id=${businessId} and id=${appointment.id}`;
    expect((await transition(appointment.id,"completed",current!.version)).statusCode).toBe(200);

    const footprint=await financialFootprint(appointment.id);
    expect(footprint.invoices).toBe(1);
    const [after]=await db<{id:string;status:string;balanceMinor:number}[]>`
      select id,status,balance_minor from invoices
      where business_id=${businessId} and appointment_id=${appointment.id}`;
    expect(after!.id).toBe(invoice.json().id);
    expect(after!.status).toBe("open");
    expect(Number(after!.balanceMinor)).toBe(8500);
  });

  it("billing a visit leaves it where it stands",async()=>{
    // The other direction of the same separation, asserted here because Ready for Pickup is the
    // only thing that may move a checked-in visit on.
    const appointment=await checkedIn();
    expect((await app.inject({method:"POST",url:`/api/appointments/${appointment.id}/checkout`,
      headers:{cookie:ownerCookie,"idempotency-key":key()},
      payload:{discountMinor:0,discountType:null,tipMinor:0}})).statusCode).toBe(201);
    expect((await row(appointment.id)).status).toBe("checked_in");
  });

  it("keeps the longer path intact",async()=>{
    const appointment=await checkedIn();
    const started=await transition(appointment.id,"in_service",appointment.version);
    expect(started.statusCode).toBe(200);
    const finished=await transition(appointment.id,"completed",started.json().version);
    expect(finished.statusCode).toBe(200);
    expect((await row(appointment.id)).status).toBe("completed");
  });

  it("refuses the edges that were never added",async()=>{
    for(const status of ["cancelled","no_show","scheduled"]){
      const appointment=await checkedIn();
      const response=await transition(appointment.id,status,appointment.version);
      expect(response.statusCode,`checked_in -> ${status}`).toBeGreaterThanOrEqual(400);
      expect((await row(appointment.id)).status).toBe("checked_in");
    }
  });

  it("requires the permission that finishing work has always required",async()=>{
    const appointment=await checkedIn();
    const refused=await transition(appointment.id,"completed",appointment.version,noCompleteCookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toContain("operations.complete");
    expect((await row(appointment.id)).status).toBe("checked_in");
  });

  it("refuses a stale version, so two desks cannot both hand the pet back",async()=>{
    const appointment=await checkedIn();
    // Somebody else writes first - an edit to the appointment note is enough - so the version this
    // caller is holding is genuinely one behind rather than a number invented by the test.
    const edited=await app.inject({method:"PATCH",url:`/api/appointments/${appointment.id}`,
      headers:{cookie:ownerCookie},payload:{notes:"Owner called about the ears"}});
    expect(edited.statusCode).toBe(200);
    const stale=await transition(appointment.id,"completed",appointment.version);
    expect(stale.statusCode).toBe(409);
    expect((await row(appointment.id)).status).toBe("checked_in");
  });
});
