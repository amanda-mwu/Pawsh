import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl=process.env.DATABASE_URL;
const describeDatabase=databaseUrl?describe:describe.skip;
const config:Config={NODE_ENV:"test",DOCUMENT_STORAGE_ADAPTER:"memory",PORT:3000,DATABASE_URL:databaseUrl??"postgres://unavailable",SESSION_SECRET:"reports-analytics-test-secret-32-chars",APP_ORIGIN:"http://localhost:3000",SMTP_PORT:587,SMTP_SECURE:false};
const cookie=(response:{headers:Record<string,unknown>})=>String(response.headers["set-cookie"]).split(";",1)[0]!;

interface ReportEmployee{id:string;displayName:string;appointmentCount:number;revenueMinor:number;tipMinor:number;commissionMinor:null}
interface ReportBody{
  totals:{
    paidRevenueMinor:number;completedAppointments:number;servicesPerformed:number;totalPets:number;
    expectedRevenueMinor:number;outstandingMinor:number;billedRevenueMinor:number;salesMinor:number;
    discountMinor:number;netMinor:number;taxMinor:number;tipMinor:number;
    unattributedRevenueMinor:number;unattributedTipMinor:number;commissionMinor:null;
  };
  revenue:{date:string;revenueMinor:string|number}[];
  employees:ReportEmployee[];
  services:{service:string;performed:number}[];
  paymentMethods:{method:string;amountMinor:number;count:number}[];
  salesItems:{servicesMinor:number;productsMinor:number;taxMinor:number;tipMinor:number};
  paymentStatus:{paidMinor:number;outstandingMinor:number};
}

// The endpoint deliberately buckets money by invoice `created_at` and operational counts by appointment
// `start_at`, so the fixtures need two windows: invoices are written now, appointments are booked on a
// fixed future day. Asserting through both windows is what pins that documented split in place.
const operationalDay="2034-04-20";
const moneyDay=new Date(Date.now()-86_400_000).toISOString().slice(0,10);

describeDatabase("reports analytics dashboard",()=>{
  let db:Database,app:Awaited<ReturnType<typeof createApp>>;
  let ownerCookie:string,businessId:string,locationId:string,secondLocationId:string;
  let serviceId:string,groomerId:string,quietGroomerId:string,customerId:string;
  let firstPetId:string,secondPetId:string;

  const fetchReport=async(localDate:string,days:number,search:string):Promise<ReportBody>=>{
    const response=await app.inject({method:"GET",url:`/api/reports?localDate=${localDate}&days=${days}${search}`,
      headers:{cookie:ownerCookie}});
    expect(response.statusCode,response.body).toBe(200);
    return response.json() as ReportBody;
  };
  const money=(search=""):Promise<ReportBody>=>fetchReport(moneyDay,3,search);
  const operations=(search=""):Promise<ReportBody>=>fetchReport(operationalDay,1,search);

  // Books, completes, checks out, and optionally pays one appointment, returning the invoice the
  // assertions reconcile against. Hours march forward so the no-overlap exclusion never fires.
  let slot=9;
  const sale=async(input:{petId:string;employeeId:string;location:string;discountMinor?:number;tipMinor?:number;
    payments?:{amountMinor:number;method:string}[]})=>{
    const localStart=`${operationalDay}T${String(slot++).padStart(2,"0")}:00`;
    // The settings write bumps only the location it touched, so each shop carries its own version.
    const [shop]=await db<{version:number}[]>`select version from locations where id=${input.location}`;
    const booking=await app.inject({method:"POST",url:"/api/appointments",
      headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},
      payload:{locationId:input.location,customerId,petId:input.petId,employeeId:input.employeeId,
        serviceIds:[serviceId],localStart,expectedLocationVersion:shop!.version}});
    expect(booking.statusCode,booking.body).toBe(201);
    const appointmentId=booking.json().id as string;
    for(const status of ["checked_in","in_service","completed"]){
      const moved=await app.inject({method:"POST",url:`/api/appointments/${appointmentId}/transition`,
        headers:{cookie:ownerCookie},payload:{status}});
      expect(moved.statusCode,`${status}: ${moved.body}`).toBe(200);
    }
    const invoice=await app.inject({method:"POST",url:`/api/appointments/${appointmentId}/checkout`,
      headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},
      payload:{discountMinor:input.discountMinor??0,tipMinor:input.tipMinor??0,
        ...(input.discountMinor?{discountType:"loyalty"}:{})}});
    expect(invoice.statusCode,invoice.body).toBe(201);
    const totals=invoice.json() as {id:string;subtotalMinor:number;discountMinor:number;taxMinor:number;
      tipMinor:number;totalMinor:number};
    let balance=totals.totalMinor;
    for(const payment of input.payments??[]){
      const recorded=await app.inject({method:"POST",url:`/api/invoices/${totals.id}/payments`,
        headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},
        payload:{amountMinor:payment.amountMinor,expectedBalanceMinor:balance,method:payment.method}});
      expect(recorded.statusCode,recorded.body).toBe(201);
      balance-=payment.amountMinor;
    }
    return {appointmentId,...totals,balanceMinor:balance};
  };

  let paidSale:Awaited<ReturnType<typeof sale>>;
  let discountedSale:Awaited<ReturnType<typeof sale>>;
  let unpaidSale:Awaited<ReturnType<typeof sale>>;
  let otherLocationSale:Awaited<ReturnType<typeof sale>>;

  beforeAll(async()=>{
    db=createDatabase(config);
    app=await createApp(config,db,{runWorker:false,serveStatic:false});
    await app.ready();
    const signup=await app.inject({method:"POST",url:"/api/auth/signup",
      payload:{email:`reports-${crypto.randomUUID()}@example.test`,password:"correct horse reports battery",
        businessName:"Reports Analytics",timezone:"UTC"}});
    expect(signup.statusCode,signup.body).toBe(201);
    ownerCookie=cookie(signup);({businessId,locationId}=signup.json());

    // Non-zero tax so the Revenue and Sales Item panels have a real tax bucket to reconcile.
    // Settings bump the location version to 2, which every booking below then asserts against.
    const settings=await app.inject({method:"PUT",url:"/api/business/settings",headers:{cookie:ownerCookie},
      payload:{name:"Reports Analytics",timezone:"UTC",currency:"USD",taxRateBasisPoints:1000,
        reminderLeadMinutes:60,locationVersion:1}});
    expect(settings.statusCode,settings.body).toBe(200);

    // There is no create-location route yet, so the second shop is seeded directly. Location scoping
    // can only be proven against a genuinely multi-location business.
    const [second]=await db<{id:string}[]>`
      insert into locations(business_id,name,address,timezone,active)
      values (${businessId},'Reports Analytics North','2 North St','UTC',true) returning id
    `;
    secondLocationId=second!.id;

    serviceId=(await app.inject({method:"POST",url:"/api/services",headers:{cookie:ownerCookie},
      payload:{name:"Full Groom",baseDurationMinutes:30,basePriceMinor:10_000,category:"GENERAL",
        pricingMode:"FIXED",active:true}})).json().id;
    groomerId=(await app.inject({method:"POST",url:"/api/employees",headers:{cookie:ownerCookie},
      payload:{displayName:"Busy Groomer",serviceIds:[serviceId]}})).json().id;
    quietGroomerId=(await app.inject({method:"POST",url:"/api/employees",headers:{cookie:ownerCookie},
      payload:{displayName:"Quiet Groomer",serviceIds:[serviceId]}})).json().id;
    customerId=(await app.inject({method:"POST",url:"/api/customers",headers:{cookie:ownerCookie},
      payload:{firstName:"Reports",lastName:"Customer"}})).json().id;
    const pet=(name:string)=>app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},
      payload:{customerId,name,species:"dog"}});
    firstPetId=(await pet("Mochi")).json().id;
    secondPetId=(await pet("Boba")).json().id;

    // 10000 + 10% tax + 500 tip = 11500, settled in cash.
    paidSale=await sale({petId:firstPetId,employeeId:groomerId,location:locationId,tipMinor:500,
      payments:[{amountMinor:11_500,method:"cash"}]});
    // 10000 - 2000 discount + 10% tax = 8800, settled across two methods; the check is voided later.
    discountedSale=await sale({petId:secondPetId,employeeId:quietGroomerId,location:locationId,
      discountMinor:2_000,payments:[{amountMinor:4_000,method:"external_card"},{amountMinor:4_800,method:"check"}]});
    // 10000 + 10% tax + 1000 tip = 12000, billed and never paid: the Expected revenue source.
    unpaidSale=await sale({petId:firstPetId,employeeId:groomerId,location:locationId,tipMinor:1_000});
    // Same window, different shop: must stay invisible while the session sits on the home location.
    otherLocationSale=await sale({petId:secondPetId,employeeId:groomerId,location:secondLocationId,
      tipMinor:9_999,payments:[{amountMinor:1_000,method:"other"}]});
  });
  afterAll(async()=>{await app.close();await db.end();});

  it("summarises appointments and pets over the operational window",async()=>{
    const body=await operations();
    expect(body.totals.completedAppointments).toBe(3);
    // Two distinct pets across three appointments: Mochi is groomed twice.
    expect(body.totals.totalPets).toBe(2);
    expect(body.totals.servicesPerformed).toBe(3);
    expect(body.services).toEqual([{service:"Full Groom",performed:3}]);
    // Money is bucketed by invoice date, so the operational window sees none of it.
    expect(body.totals.billedRevenueMinor).toBe(0);
    expect(body.totals.paidRevenueMinor).toBe(0);
  });

  it("reports revenue, sales item, and payment status panels that reconcile with the invoices",async()=>{
    const body=await money();
    const billed=paidSale.totalMinor+discountedSale.totalMinor+unpaidSale.totalMinor;
    const collected=paidSale.totalMinor+discountedSale.totalMinor;

    expect(billed).toBe(32_300);
    expect(body.totals.paidRevenueMinor).toBe(collected);
    expect(body.totals.billedRevenueMinor).toBe(billed);
    expect(body.totals.expectedRevenueMinor).toBe(unpaidSale.totalMinor);
    expect(body.totals.outstandingMinor).toBe(body.totals.expectedRevenueMinor);
    expect(body.totals.salesMinor).toBe(30_000);
    expect(body.totals.discountMinor).toBe(2_000);
    expect(body.totals.netMinor).toBe(28_000);
    expect(body.totals.taxMinor).toBe(2_800);
    expect(body.totals.tipMinor).toBe(1_500);

    // Identities the Revenue bar chart depends on.
    expect(body.totals.salesMinor-body.totals.discountMinor).toBe(body.totals.netMinor);
    expect(body.totals.netMinor+body.totals.taxMinor+body.totals.tipMinor).toBe(body.totals.billedRevenueMinor);
    expect(body.totals.paidRevenueMinor+body.totals.expectedRevenueMinor).toBe(body.totals.billedRevenueMinor);

    expect(body.salesItems).toEqual({servicesMinor:28_000,productsMinor:0,taxMinor:2_800,tipMinor:1_500});
    expect(Object.values(body.salesItems).reduce((sum,value)=>sum+value,0)).toBe(body.totals.billedRevenueMinor);
    expect(body.paymentStatus).toEqual({paidMinor:collected,outstandingMinor:unpaidSale.totalMinor});
    expect(body.revenue.reduce((sum,row)=>sum+Number(row.revenueMinor),0)).toBe(collected);
  });

  it("breaks collected money down by method and drops voided payments from every panel",async()=>{
    const before=await money();
    const byMethod=(body:ReportBody)=>Object.fromEntries(body.paymentMethods.map(row=>[row.method,row]));
    expect(byMethod(before).cash).toEqual({method:"cash",amountMinor:11_500,count:1});
    expect(byMethod(before).external_card).toEqual({method:"external_card",amountMinor:4_000,count:1});
    expect(byMethod(before).check).toEqual({method:"check",amountMinor:4_800,count:1});
    expect(before.paymentMethods.reduce((sum,row)=>sum+row.amountMinor,0)).toBe(before.totals.paidRevenueMinor);

    const [check]=await db<{id:string}[]>`
      select id from payments
      where business_id=${businessId} and invoice_id=${discountedSale.id} and method='check'
    `;
    const voided=await app.inject({method:"POST",url:`/api/payments/${check!.id}/void`,
      headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},
      payload:{reason:"Reporting regression: voided money must leave every panel"}});
    expect(voided.statusCode,voided.body).toBe(200);

    const after=await money();
    expect(after.paymentMethods.map(row=>row.method).sort()).toEqual(["cash","external_card"]);
    expect(after.paymentMethods.reduce((sum,row)=>sum+row.amountMinor,0)).toBe(after.totals.paidRevenueMinor);
    expect(after.totals.paidRevenueMinor).toBe(before.totals.paidRevenueMinor-4_800);
    expect(after.totals.outstandingMinor).toBe(before.totals.outstandingMinor+4_800);
    // A void moves money between paid and outstanding; it never changes what was billed.
    expect(after.totals.billedRevenueMinor).toBe(before.totals.billedRevenueMinor);
    expect(after.paymentStatus).toEqual({paidMinor:after.totals.paidRevenueMinor,
      outstandingMinor:after.totals.outstandingMinor});
  });

  it("attributes revenue and tips per groomer without inventing a commission",async()=>{
    const body=await money();
    const rows=Object.fromEntries(body.employees.map(row=>[row.id,row]));
    // Busy Groomer: the fully paid 11500 sale plus the unpaid 12000 sale, which collected nothing but
    // still carries its 1000 tip on the invoice.
    expect(rows[groomerId]).toMatchObject({displayName:"Busy Groomer",revenueMinor:11_500,
      tipMinor:1_500,commissionMinor:null});
    // Quiet Groomer: 8800 billed, 4000 still collected after the check was voided.
    expect(rows[quietGroomerId]).toMatchObject({displayName:"Quiet Groomer",revenueMinor:4_000,
      tipMinor:0,commissionMinor:null});
    // Every fixture appointment carries an assignment, so nothing is left unattributed and the staff
    // bars add up exactly. Real data contains legacy appointments with no `appointment_employees` row;
    // that remainder is what `unattributedRevenueMinor` exists to surface instead of quietly losing.
    expect(body.totals.unattributedRevenueMinor).toBe(0);
    expect(body.totals.unattributedTipMinor).toBe(0);
    const attributed=body.employees.reduce((sum,row)=>sum+row.revenueMinor,0);
    expect(attributed+body.totals.unattributedRevenueMinor).toBe(body.totals.paidRevenueMinor);
    expect(body.employees.reduce((sum,row)=>sum+row.tipMinor,0)+body.totals.unattributedTipMinor)
      .toBe(body.totals.tipMinor);

    const operational=await operations();
    expect(Object.fromEntries(operational.employees.map(row=>[row.id,row.appointmentCount])))
      .toMatchObject({[groomerId]:2,[quietGroomerId]:1});
    expect(operational.employees.reduce((sum,row)=>sum+row.appointmentCount,0))
      .toBe(operational.totals.completedAppointments);

    // Commission has no source of truth anywhere in this schema. The keys stay present and null so the
    // dashboard renders an honest empty panel instead of a fabricated number.
    expect(body.totals.commissionMinor).toBeNull();
    expect(body.employees.every(row=>row.commissionMinor===null)).toBe(true);
  });

  it("honours the groomer filter across every new aggregate",async()=>{
    const filtered=await money(`&employeeIds=${quietGroomerId}`);
    expect(filtered.employees.map(row=>row.id)).toEqual([quietGroomerId]);
    expect(filtered.totals.billedRevenueMinor).toBe(discountedSale.totalMinor);
    expect(filtered.totals.salesMinor).toBe(10_000);
    expect(filtered.totals.discountMinor).toBe(2_000);
    expect(filtered.totals.netMinor).toBe(8_000);
    expect(filtered.totals.tipMinor).toBe(0);
    expect(filtered.salesItems).toEqual({servicesMinor:8_000,productsMinor:0,
      taxMinor:discountedSale.taxMinor,tipMinor:0});
    expect(filtered.paymentMethods).toEqual([{method:"external_card",amountMinor:4_000,count:1}]);
    expect(filtered.paymentStatus).toEqual({paidMinor:4_000,outstandingMinor:4_800});

    const operational=await operations(`&employeeIds=${quietGroomerId}`);
    expect(operational.totals.completedAppointments).toBe(1);
    expect(operational.totals.totalPets).toBe(1);
    expect(operational.totals.servicesPerformed).toBe(1);

    const stranger=await money(`&employeeIds=${crypto.randomUUID()}`);
    // Exhaustive on purpose: a figure added to `totals` without a decision about what it means
    // for an empty report has to fail here rather than appear on a dashboard as a silent zero.
    // `refundedMinor` and `netCollectedMinor` are the Phase G additions - collected money is still
    // `paidRevenueMinor`, and what went back is stated separately rather than netted into it.
    expect(stranger.totals).toEqual({
      paidRevenueMinor:0,completedAppointments:0,servicesPerformed:0,totalPets:0,
      expectedRevenueMinor:0,outstandingMinor:0,billedRevenueMinor:0,salesMinor:0,
      discountMinor:0,netMinor:0,taxMinor:0,tipMinor:0,unattributedRevenueMinor:0,
      unattributedTipMinor:0,commissionMinor:null,
      refundedMinor:0,refundedTipMinor:0,refundCount:0,netCollectedMinor:0
    });
    expect(stranger.revenue).toEqual([]);
    expect(stranger.paymentMethods).toEqual([]);
    expect(stranger.salesItems).toEqual({servicesMinor:0,productsMinor:0,taxMinor:0,tipMinor:0});
    expect(stranger.paymentStatus).toEqual({paidMinor:0,outstandingMinor:0});
  });

  it("scopes every aggregate to the session's active location",async()=>{
    const home=await money();
    expect(home.totals.tipMinor).toBe(1_500);
    expect(home.paymentMethods.some(row=>row.method==="other")).toBe(false);

    const switched=await app.inject({method:"POST",url:"/api/me/location",headers:{cookie:ownerCookie},
      payload:{locationId:secondLocationId}});
    expect(switched.statusCode,switched.body).toBe(200);

    const north=await money();
    expect(north.totals.billedRevenueMinor).toBe(otherLocationSale.totalMinor);
    expect(north.totals.tipMinor).toBe(9_999);
    expect(north.totals.paidRevenueMinor).toBe(1_000);
    expect(north.totals.outstandingMinor).toBe(otherLocationSale.totalMinor-1_000);
    expect(north.paymentMethods).toEqual([{method:"other",amountMinor:1_000,count:1}]);
    expect(north.revenue.reduce((sum,row)=>sum+Number(row.revenueMinor),0)).toBe(1_000);
    expect(north.employees.reduce((sum,row)=>sum+row.revenueMinor,0)).toBe(1_000);

    const northOperations=await operations();
    expect(northOperations.totals.completedAppointments).toBe(1);
    expect(northOperations.totals.totalPets).toBe(1);
    expect(northOperations.totals.servicesPerformed).toBe(1);
    expect(northOperations.employees.reduce((sum,row)=>sum+row.appointmentCount,0)).toBe(1);

    const restored=await app.inject({method:"POST",url:"/api/me/location",headers:{cookie:ownerCookie},
      payload:{locationId}});
    expect(restored.statusCode).toBe(200);
    expect((await money()).totals.billedRevenueMinor).toBe(home.totals.billedRevenueMinor);
  });

  it("returns integer minor units and integer counts, never bigint strings or floats",async()=>{
    const body=await money();
    const scalars=[...Object.entries(body.totals),...Object.entries(body.salesItems),
      ...Object.entries(body.paymentStatus)];
    for(const [key,value] of scalars){
      if(value===null){expect(key).toBe("commissionMinor");continue;}
      expect(typeof value,key).toBe("number");
      expect(Number.isInteger(value),`${key}=${String(value)}`).toBe(true);
    }
    for(const row of body.paymentMethods){
      expect(Number.isInteger(row.amountMinor)).toBe(true);
      expect(Number.isInteger(row.count)).toBe(true);
    }
    for(const row of body.employees){
      expect(Number.isInteger(row.revenueMinor)).toBe(true);
      expect(Number.isInteger(row.tipMinor)).toBe(true);
      expect(Number.isInteger(row.appointmentCount)).toBe(true);
    }
  });

  // Ordered after the reconciliation cases: it permanently removes an assignment row for this business.
  it("surfaces revenue that belongs to no groomer instead of quietly losing it",async()=>{
    const before=await money();
    // scripts/seed-qa.ts inserts appointments straight into `appointments` without the matching
    // `appointment_employees` row, so real databases contain completed, invoiced, PAID appointments
    // that no groomer is attributable for. Reproduce exactly that shape.
    const removed=await db`
      delete from appointment_employees where appointment_id=${paidSale.appointmentId}
    `;
    expect(removed.count).toBe(1);

    const after=await money();
    // The business figures are untouched: the money was still collected.
    expect(after.totals.paidRevenueMinor).toBe(before.totals.paidRevenueMinor);
    expect(after.totals.tipMinor).toBe(before.totals.tipMinor);
    // The groomer simply loses the credit, and the remainder is reported rather than dropped.
    const rows=Object.fromEntries(after.employees.map(row=>[row.id,row]));
    expect(rows[groomerId]!.revenueMinor).toBe(0);
    expect(after.totals.unattributedRevenueMinor).toBe(paidSale.totalMinor);
    expect(after.totals.unattributedTipMinor).toBe(paidSale.tipMinor);
    expect(after.employees.reduce((sum,row)=>sum+row.revenueMinor,0)+after.totals.unattributedRevenueMinor)
      .toBe(after.totals.paidRevenueMinor);
    expect(after.employees.reduce((sum,row)=>sum+row.tipMinor,0)+after.totals.unattributedTipMinor)
      .toBe(after.totals.tipMinor);
  });

  it("keeps every legacy response key the charts, table, and smoke suite already read",async()=>{
    const body=await money();
    expect(Object.keys(body).sort()).toEqual([
      "days","employeeIds","employees","from","localDate","paymentMethods","paymentStatus",
      "revenue","salesItems","services","to","totals"
    ]);
    expect(body.totals.paidRevenueMinor).toBeTypeOf("number");
    expect(body.totals.completedAppointments).toBeTypeOf("number");
    expect(body.totals.servicesPerformed).toBeTypeOf("number");
    expect(body.revenue.every(row=>typeof row.date==="string"&&row.revenueMinor!==undefined)).toBe(true);
    expect(body.employees.every(row=>typeof row.displayName==="string"&&typeof row.appointmentCount==="number")).toBe(true);
    expect(body.services.every(row=>typeof row.service==="string"&&typeof row.performed==="number")).toBe(true);
  });
});
