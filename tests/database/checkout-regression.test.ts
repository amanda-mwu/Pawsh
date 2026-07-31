import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { tokenHash } from "../../src/http/context.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV:"test",DOCUMENT_STORAGE_ADAPTER:"memory",PORT:3000,
  DATABASE_URL:databaseUrl??"postgres://unavailable",
  SESSION_SECRET:"test-session-secret-at-least-thirty-two-characters",
  APP_ORIGIN:"http://localhost:3000",SMTP_PORT:587,SMTP_SECURE:false
};

function cookie(response: { headers: Record<string, unknown> }): string {
  const value=response.headers["set-cookie"];
  if(typeof value!=="string")throw new Error("Session cookie missing");
  return value.split(";",1)[0]!;
}

describeDatabase("D4 checkout, stale state, and error paths",()=>{
  let db:Database;
  let app:Awaited<ReturnType<typeof createApp>>;
  let failBeforeAudit:"checkout.create-invoice"|"payment.record"|"payment.void"|null=null;
  let loseAfterCommit:"checkout.create-invoice"|"payment.record"|"payment.void"|null=null;
  let ownerCookie="",memberCookie="",businessId="",locationId="",employeeId="",serviceId="",customerId="",petId="";
  const suffix=crypto.randomUUID();
  const key=():string=>crypto.randomUUID();
  const headers=(session=ownerCookie,idempotencyKey=key())=>({cookie:session,"idempotency-key":idempotencyKey});

  async function createCompleted(startHour:number,withService=true){
    const [appointment]=await db<{id:string}[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,status,created_by,updated_by)
      select ${businessId},${locationId},${customerId},${petId},${employeeId},
        ${`2034-04-${String(startHour).padStart(2,"0")}T16:00:00.000Z`}::timestamptz,
        ${`2034-04-${String(startHour).padStart(2,"0")}T17:00:00.000Z`}::timestamptz,'completed',user_id,user_id
      from business_memberships where business_id=${businessId} and is_owner returning id
    `;
    if(withService)await db`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment!.id},${serviceId},'D4 Groom Snapshot',60,8500)
    `;
    return appointment!.id;
  }

  async function checkout(appointmentId:string,input={discountMinor:500,discountType:"manual" as string|null,tipMinor:1500},requestKey=key(),session=ownerCookie){
    return app.inject({method:"POST",url:`/api/appointments/${appointmentId}/checkout`,headers:headers(session,requestKey),payload:input});
  }
  async function pay(invoiceId:string,amountMinor:number,expectedBalanceMinor:number,requestKey=key(),session=ownerCookie){
    return app.inject({method:"POST",url:`/api/invoices/${invoiceId}/payments`,headers:headers(session,requestKey),
      payload:{amountMinor,expectedBalanceMinor,method:"cash",externalReference:null}});
  }

  beforeAll(async()=>{
    db=createDatabase(config);
    app=await createApp(config,db,{runWorker:false,serveStatic:false,financialHooks:{
      async beforeFinancialAudit(operation){if(failBeforeAudit===operation){failBeforeAudit=null;throw new Error("controlled financial rollback");}},
      async afterFinancialCommit(operation){if(loseAfterCommit===operation){loseAfterCommit=null;throw new Error("controlled response loss");}}
    }});
    await app.ready();
    const signup=await app.inject({method:"POST",url:"/api/auth/signup",payload:{
      email:`d4-owner-${suffix}@example.test`,password:"correct horse d4 checkout",businessName:"D4 Commerce"
    }});
    ownerCookie=cookie(signup);({businessId,locationId}=signup.json());
    await app.inject({method:"PUT",url:"/api/business/settings",headers:{cookie:ownerCookie},payload:{
      name:"D4 Commerce",timezone:"America/Los_Angeles",currency:"USD",taxRateBasisPoints:825,reminderLeadMinutes:1440
    }});
    const service=await app.inject({method:"POST",url:"/api/services",headers:{cookie:ownerCookie},payload:{name:"D4 Groom",baseDurationMinutes:60,basePriceMinor:8500}});
    serviceId=service.json().id;
    const employee=await app.inject({method:"POST",url:"/api/employees",headers:{cookie:ownerCookie},payload:{displayName:"D4 Groomer",serviceIds:[serviceId]}});
    employeeId=employee.json().id;
    const customer=await app.inject({method:"POST",url:"/api/customers",headers:{cookie:ownerCookie},payload:{firstName:"D4",lastName:"Customer",preferredContactMethod:"none"}});
    customerId=customer.json().id;
    const pet=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},payload:{customerId,name:"D4 Pet",species:"dog"}});
    petId=pet.json().id;
    const passwordHash=await hashPassword("correct horse d4 member");
    const token=crypto.randomUUID();
    const [member]=await db<{id:string;userId:string}[]>`
      with account as (
        insert into users(email,normalized_email,password_hash) values
          (${`d4-member-${suffix}@example.test`},${`d4-member-${suffix}@example.test`},${passwordHash}) returning id
      )
      insert into business_memberships(business_id,user_id,permissions)
      select ${businessId},id,array['checkout.perform','payments.view','discounts.apply'] from account returning id,user_id
    `;
    await db`insert into sessions(user_id,token_hash,expires_at) values (${member!.userId},${tokenHash(token)},now()+interval '1 day')`;
    memberCookie=`pawsh_session=${token}`;
  });
  afterAll(async()=>{await app.close();await db.end();});

  it("uses immutable snapshots, rejects incompatible intent, and settles zero totals",async()=>{
    const appointmentId=await createCompleted(2);
    await db`update services set base_price_minor=9900 where business_id=${businessId} and id=${serviceId}`;
    const requestKey=key();
    const first=await checkout(appointmentId,undefined,requestKey);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({subtotalMinor:8500,discountMinor:500,tipMinor:1500,totalMinor:10160,status:"open"});
    const replay=await checkout(appointmentId,undefined,requestKey,memberCookie);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    const reused=await checkout(appointmentId,{discountMinor:0,discountType:null,tipMinor:0},requestKey);
    expect(reused.statusCode).toBe(409);expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    const compatible=await checkout(appointmentId);
    expect(compatible.statusCode).toBe(200);
    const incompatible=await checkout(appointmentId,{discountMinor:0,discountType:null,tipMinor:0});
    expect(incompatible.statusCode).toBe(409);
    expect(incompatible.json()).toMatchObject({code:"INVOICE_ALREADY_EXISTS",invoice:{id:first.json().id}});
    const [counts]=await db<{audits:number;outbox:number;analytics:number}[]>`
      select
        (select count(*)::integer from audit_events where business_id=${businessId} and resource_id=${first.json().id} and action='invoice.create') audits,
        (select count(*)::integer from outbox_events where business_id=${businessId} and resource_id=${first.json().id} and event_type='InvoiceCreated') outbox,
        (select count(*)::integer from product_analytics_events where business_id=${businessId} and resource_id=${first.json().id} and event_name='InvoiceCreated') analytics
    `;
    expect(counts).toEqual({audits:1,outbox:1,analytics:1});

    const zeroAppointment=await createCompleted(3);
    const zero=await checkout(zeroAppointment,{discountMinor:8500,discountType:"courtesy",tipMinor:0});
    expect(zero.json()).toMatchObject({totalMinor:0,balanceMinor:0,status:"paid"});
    const noService=await checkout(await createCompleted(4,false),{discountMinor:0,discountType:null,tipMinor:0});
    expect(noService.statusCode).toBe(409);
    expect(noService.json().code).toBe("CHECKOUT_REQUIRES_SERVICE");
  });

  it("serializes valid partial payments and rejects a stale aggregate overpayment",async()=>{
    const invoice=(await checkout(await createCompleted(5),{discountMinor:0,discountType:null,tipMinor:1500})).json();
    const [a,b]=await Promise.all([
      pay(invoice.id,4000,invoice.balanceMinor),pay(invoice.id,3000,invoice.balanceMinor)
    ]);
    expect([a.statusCode,b.statusCode]).toEqual([201,201]);
    const receipt=await app.inject({method:"GET",url:`/api/invoices/${invoice.id}/receipt`,headers:{cookie:ownerCookie}});
    const current=receipt.json().invoice.balanceMinor;
    expect(current).toBe(invoice.balanceMinor-7000);
    const valid=await pay(invoice.id,current,current);
    expect(valid.statusCode).toBe(201);
    const stale=await pay(invoice.id,current, current);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("STALE_FINANCIAL_STATE");
    const updated=(await app.inject({method:"GET",url:`/api/invoices/${invoice.id}/receipt`,headers:{cookie:ownerCookie}})).json();
    expect(updated.invoice.balanceMinor).toBeGreaterThanOrEqual(0);
    expect(updated.payments.filter((payment:{status:string})=>payment.status==="recorded")
      .reduce((sum:number,payment:{amountMinor:number})=>sum+payment.amountMinor,0)).toBe(invoice.totalMinor-updated.invoice.balanceMinor);
  });

  it("deduplicates same-key payment concurrency and preserves one void effect",async()=>{
    const invoice=(await checkout(await createCompleted(6),{discountMinor:0,discountType:null,tipMinor:1500})).json();
    const paymentKey=key();
    const [first,second]=await Promise.all([pay(invoice.id,5000,10000,paymentKey),pay(invoice.id,5000,10000,paymentKey)]);
    expect([first.statusCode,second.statusCode].sort()).toEqual([200,201]);
    expect(first.json().id).toBe(second.json().id);
    const reused=await pay(invoice.id,4000,5000,paymentKey);
    expect(reused.statusCode).toBe(409);expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    const paymentId=first.json().id;
    const voidKey=key();
    const voidCall=(requestKey:string)=>app.inject({method:"POST",url:`/api/payments/${paymentId}/void`,headers:headers(ownerCookie,requestKey),payload:{reason:"Duplicate terminal record"}});
    const [voidA,voidB]=await Promise.all([voidCall(voidKey),voidCall(voidKey)]);
    expect(voidA.statusCode).toBe(200);expect(voidB.statusCode).toBe(200);
    const repeat=await voidCall(key());
    expect(repeat.statusCode).toBe(409);expect(repeat.json().code).toBe("PAYMENT_ALREADY_VOIDED");
    const [counts]=await db<{paymentAudits:number;paymentOutbox:number;voidAudits:number;voidOutbox:number}[]>`
      select
        (select count(*)::integer from audit_events where business_id=${businessId} and resource_id=${paymentId} and action='payment.record') payment_audits,
        (select count(*)::integer from outbox_events where business_id=${businessId} and resource_id=${paymentId} and event_type='PaymentRecorded') payment_outbox,
        (select count(*)::integer from audit_events where business_id=${businessId} and resource_id=${paymentId} and action='payment.void') void_audits,
        (select count(*)::integer from outbox_events where business_id=${businessId} and resource_id=${paymentId}) void_outbox
    `;
    expect(counts).toMatchObject({paymentAudits:1,paymentOutbox:1,voidAudits:1});
    expect(counts!.voidOutbox).toBe(1);
  });

  it("rolls back claims and replays committed results after response loss",async()=>{
    const appointmentId=await createCompleted(7);
    const rollbackKey=key();failBeforeAudit="checkout.create-invoice";
    const failed=await checkout(appointmentId,undefined,rollbackKey);
    expect(failed.statusCode).toBe(400);
    const [rolledBack]=await db<{invoices:number;requests:number}[]>`
      select
       (select count(*)::integer from invoices where business_id=${businessId} and appointment_id=${appointmentId}) invoices,
       (select count(*)::integer from financial_idempotency_requests where business_id=${businessId} and idempotency_key=${rollbackKey}) requests
    `;
    expect(rolledBack).toEqual({invoices:0,requests:0});
    loseAfterCommit="checkout.create-invoice";
    const lost=await checkout(appointmentId,undefined,rollbackKey);
    expect(lost.statusCode).toBe(400);
    const recovered=await checkout(appointmentId,undefined,rollbackKey);
    expect(recovered.statusCode).toBe(200);
    const invoice=recovered.json();
    const paymentKey=key();loseAfterCommit="payment.record";
    expect((await pay(invoice.id,invoice.balanceMinor,invoice.balanceMinor,paymentKey)).statusCode).toBe(400);
    const paymentReplay=await pay(invoice.id,invoice.balanceMinor,invoice.balanceMinor,paymentKey);
    expect(paymentReplay.statusCode).toBe(200);
    const voidKey=key();loseAfterCommit="payment.void";
    expect((await app.inject({method:"POST",url:`/api/payments/${paymentReplay.json().id}/void`,headers:headers(ownerCookie,voidKey),payload:{reason:"Response loss proof"}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:`/api/payments/${paymentReplay.json().id}/void`,headers:headers(ownerCookie,voidKey),payload:{reason:"Response loss proof"}})).statusCode).toBe(200);
  });

  it("requires current replay authority and keeps receipt history deterministic",async()=>{
    const appointmentId=await createCompleted(8);
    const replayKey=key();
    const invoice=await checkout(appointmentId,undefined,replayKey,memberCookie);
    expect(invoice.statusCode).toBe(201);
    await db`update business_memberships set permissions=array['payments.view'] where business_id=${businessId} and user_id=(select user_id from sessions where token_hash=${tokenHash(memberCookie.slice("pawsh_session=".length))})`;
    const denied=await checkout(appointmentId,undefined,replayKey,memberCookie);
    expect(denied.statusCode).toBe(403);
    const paymentA=await pay(invoice.json().id,3000,invoice.json().balanceMinor);
    const paymentB=await pay(invoice.json().id,2000,invoice.json().balanceMinor-3000);
    await app.inject({method:"POST",url:`/api/payments/${paymentA.json().id}/void`,headers:headers(),payload:{reason:"Ordering proof"}});
    const receipt=await app.inject({method:"GET",url:`/api/invoices/${invoice.json().id}/receipt`,headers:{cookie:ownerCookie}});
    expect(receipt.statusCode).toBe(200);
    const paymentIds=receipt.json().payments.map((payment:{id:string})=>payment.id);
    expect(paymentIds).toEqual([paymentA.json().id,paymentB.json().id]);
    expect(receipt.json().items.map((item:{linePosition:number})=>item.linePosition)).toEqual([1]);
  });

  it("records bounded D4 operation and replay diagnostics",async()=>{
    const samples=[];
    for(let index=0;index<5;index+=1){
      const appointmentId=await createCompleted(9+index);
      const checkoutKey=key();let started=performance.now();
      const invoiceResponse=await checkout(appointmentId,{discountMinor:0,discountType:null,tipMinor:0},checkoutKey);
      const checkoutMs=Number((performance.now()-started).toFixed(2));
      const invoice=invoiceResponse.json();
      started=performance.now();
      const replay=await checkout(appointmentId,{discountMinor:0,discountType:null,tipMinor:0},checkoutKey);
      const replayMs=Number((performance.now()-started).toFixed(2));
      started=performance.now();
      const payment=await pay(invoice.id,invoice.balanceMinor,invoice.balanceMinor);
      const paymentMs=Number((performance.now()-started).toFixed(2));
      started=performance.now();
      const receipt=await app.inject({method:"GET",url:`/api/invoices/${invoice.id}/receipt`,headers:{cookie:ownerCookie}});
      const receiptMs=Number((performance.now()-started).toFixed(2));
      started=performance.now();
      const voided=await app.inject({method:"POST",url:`/api/payments/${payment.json().id}/void`,headers:headers(),payload:{reason:"Diagnostic void"}});
      const voidMs=Number((performance.now()-started).toFixed(2));
      expect([invoiceResponse.statusCode,replay.statusCode,payment.statusCode,receipt.statusCode,voided.statusCode])
        .toEqual([201,200,201,200,200]);
      samples.push({checkoutMs,replayMs,paymentMs,receiptMs,voidMs,receiptBytes:Buffer.byteLength(receipt.body)});
    }
    console.log("D4_FINANCIAL_DIAGNOSTICS",JSON.stringify({
      environment:"CI PostgreSQL/API injection; browser and worker startup excluded",sampleCount:samples.length,samples
    }));
  });
});
