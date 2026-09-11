import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * WHICH VISITS MAY BE BILLED, AND WHAT BILLING ONE DOES NOT DO.
 *
 * Checkout required `completed`, which said that a bill is the last step of the lifecycle. It is
 * not. A pet dropped off in the morning can be paid for at the desk while it is still in the
 * salon, and the operator marks the work finished afterwards - so `checked_in` bills as readily
 * as `completed`, and the four remaining statuses stay refused.
 *
 * The half of this that is easy to lose is the second one. Entering checkout MUST NOT advance the
 * visit. `completed` means the grooming is done; it does not mean paid, and paid does not mean
 * done. If raising an invoice ever moved a `checked_in` appointment to `completed` the two facts
 * would have been welded together, and a salon would be unable to tell a pet that is ready to go
 * home from one that has merely been paid for.
 *
 * --- WHAT A MUTATION HAS TO BREAK --------------------------------------------------------------
 *
 *   `canEnterCheckout(...)` -> `appointment.status === "completed"`
 *       "bills a checked-in visit where it stands" fails.
 *
 *   `canEnterCheckout(...)` -> `true`
 *       all four of the "refuses ..." cases fail.
 *
 *   `checkoutEligibleStatuses` gains `in_service`
 *       "refuses an in service visit" fails.
 *
 *   an `update appointments set status='completed'` added to the checkout handler
 *       "billing a visit does not finish it" fails.
 *
 *   the existing-invoice lookup dropped from the handler
 *       "reuses the invoice a checked-in visit already has" and "a replay of the same request
 *       raises no second invoice" both fail on the row count.
 *
 *   the claim moved below the lifecycle gate
 *       "keeps the idempotency claim ahead of the lifecycle gate" fails.
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

describeDatabase("checkout eligibility",()=>{
  let db:Database;
  let app:Awaited<ReturnType<typeof createApp>>;
  let ownerCookie="",businessId="",locationId="",employeeId="",serviceId="",customerId="",petId="";
  const suffix=crypto.randomUUID();
  const key=():string=>crypto.randomUUID();
  const headers=(idempotencyKey=key())=>({cookie:ownerCookie,"idempotency-key":idempotencyKey});

  /** A visit on its own day, so the overlap triggers never speak in this file. */
  let day=1;
  async function appointmentIn(status:string,{withService=true}={}){
    const at=`2035-06-${String(++day).padStart(2,"0")}`;
    const [appointment]=await db<{id:string}[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      select ${businessId},${locationId},${customerId},${petId},${employeeId},
        ${`${at}T16:00:00.000Z`}::timestamptz,${`${at}T17:00:00.000Z`}::timestamptz,'America/Los_Angeles',
        ${`${at}T16:00:00.000Z`}::timestamptz at time zone 'America/Los_Angeles',-420,${status},user_id,user_id
      from business_memberships where business_id=${businessId} and is_owner returning id
    `;
    if(withService)await db`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
        duration_minutes_snapshot,price_minor_snapshot,line_position)
      values (${businessId},${appointment!.id},${serviceId},'Eligibility Groom Snapshot',60,8500,1)
    `;
    return appointment!.id;
  }

  async function checkout(appointmentId:string,requestKey=key(),
    input={discountMinor:0,discountType:null as string|null,tipMinor:0}){
    return app.inject({method:"POST",url:`/api/appointments/${appointmentId}/checkout`,
      headers:headers(requestKey),payload:input});
  }

  async function statusOf(appointmentId:string){
    const [row]=await db<{status:string}[]>`
      select status from appointments where business_id=${businessId} and id=${appointmentId}`;
    return row!.status;
  }

  async function invoiceCount(appointmentId:string){
    const [row]=await db<{count:number}[]>`
      select count(*)::integer count from invoices
      where business_id=${businessId} and appointment_id=${appointmentId} and status<>'void'`;
    return row!.count;
  }

  beforeAll(async()=>{
    db=createDatabase(config);
    app=await createApp(config,db,{runWorker:false,serveStatic:false});
    await app.ready();
    const signup=await app.inject({method:"POST",url:"/api/auth/signup",payload:{
      email:`eligibility-owner-${suffix}@example.test`,password:"correct horse checkout eligibility",
      businessName:"Eligibility Grooming"
    }});
    ownerCookie=cookie(signup);({businessId,locationId}=signup.json());
    await app.inject({method:"PUT",url:"/api/business/settings",headers:{cookie:ownerCookie},payload:{
      name:"Eligibility Grooming",timezone:"America/Los_Angeles",currency:"USD",
      taxRateBasisPoints:0,reminderLeadMinutes:1440,locationVersion:1
    }});
    serviceId=(await app.inject({method:"POST",url:"/api/services",headers:{cookie:ownerCookie},
      payload:{name:"Eligibility Groom",baseDurationMinutes:60,basePriceMinor:8500}})).json().id;
    employeeId=(await app.inject({method:"POST",url:"/api/employees",headers:{cookie:ownerCookie},
      payload:{displayName:"Eligibility Groomer",serviceIds:[serviceId]}})).json().id;
    customerId=(await app.inject({method:"POST",url:"/api/customers",headers:{cookie:ownerCookie},
      payload:{firstName:"Eli",lastName:"Gibbs",preferredContactMethod:"none"}})).json().id;
    petId=(await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},
      payload:{customerId,name:"Marble",species:"dog"}})).json().id;
  });
  afterAll(async()=>{await app.close();await db.end();});

  it("bills a checked-in visit where it stands",async()=>{
    const appointmentId=await appointmentIn("checked_in");
    const response=await checkout(appointmentId);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({appointmentId,subtotalMinor:8500,totalMinor:8500,status:"open"});
  });

  it("still bills a completed visit",async()=>{
    const appointmentId=await appointmentIn("completed");
    const response=await checkout(appointmentId);
    expect(response.statusCode).toBe(201);
    expect(response.json().totalMinor).toBe(8500);
  });

  // Each refusal is its own case, so a widening that lets one through cannot hide behind the rest.
  for(const status of ["scheduled","in_service","cancelled","no_show"]){
    it(`refuses a ${status.replace("_"," ")} visit, and raises nothing`,async()=>{
      const appointmentId=await appointmentIn(status);
      const response=await checkout(appointmentId);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("STALE_FINANCIAL_STATE");
      // The refusal is not merely reported: the transaction rolled back and no bill exists.
      expect(await invoiceCount(appointmentId)).toBe(0);
      expect(await statusOf(appointmentId)).toBe(status);
    });
  }

  it("billing a visit does not finish it",async()=>{
    const appointmentId=await appointmentIn("checked_in");
    expect((await checkout(appointmentId)).statusCode).toBe(201);
    // THE WHOLE POINT. The pet is billed and still in the salon; whoever hands it back says so
    // separately, through the transition route, and this handler never touched the status.
    expect(await statusOf(appointmentId)).toBe("checked_in");
  });

  it("reuses the invoice a checked-in visit already has",async()=>{
    const appointmentId=await appointmentIn("checked_in");
    const first=await checkout(appointmentId);
    expect(first.statusCode).toBe(201);
    // A different idempotency key, the same intent: the existing-invoice lookup answers it, and
    // answers it with the SAME invoice rather than a second one.
    const again=await checkout(appointmentId);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
    expect(await invoiceCount(appointmentId)).toBe(1);
  });

  it("a replay of the same request raises no second invoice",async()=>{
    const appointmentId=await appointmentIn("checked_in");
    const requestKey=key();
    const first=await checkout(appointmentId,requestKey);
    expect(first.statusCode).toBe(201);
    const replay=await checkout(appointmentId,requestKey);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    expect(await invoiceCount(appointmentId)).toBe(1);
    expect(await statusOf(appointmentId)).toBe("checked_in");
  });

  it("keeps the idempotency claim ahead of the lifecycle gate",async()=>{
    // ORDERING, NOT JUST OUTCOME. The claim is made before the status is judged, so a visit that
    // is billed and THEN moved still answers its own replay out of the completed claim, instead
    // of re-running the gate against a status that has since changed underneath it.
    const appointmentId=await appointmentIn("checked_in");
    const requestKey=key();
    const first=await checkout(appointmentId,requestKey);
    expect(first.statusCode).toBe(201);
    await db`update appointments set status='no_show' where business_id=${businessId} and id=${appointmentId}`;
    const replay=await checkout(appointmentId,requestKey);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
  });

  it("still refuses a billable visit that has no service on it",async()=>{
    // The gate widened; the checks after it did not. A checked-in visit with nothing to charge
    // for reaches CHECKOUT_REQUIRES_SERVICE exactly as a completed one always did.
    const appointmentId=await appointmentIn("checked_in",{withService:false});
    const response=await checkout(appointmentId);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("CHECKOUT_REQUIRES_SERVICE");
    expect(await invoiceCount(appointmentId)).toBe(0);
  });

  it("refuses an unknown appointment with 404 rather than the lifecycle 409",async()=>{
    const response=await checkout(crypto.randomUUID());
    expect(response.statusCode).toBe(404);
  });
});
