import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { deliverNotifications, processOutbox, type EmailMessage, type EmailProvider } from "../../src/engagement/worker.js";
import { openSecret } from "../../src/security/secrets.js";
import { createRole } from "../support/roles.js";
import { permissions } from "@pawsh/domain";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test",
  DOCUMENT_STORAGE_ADAPTER: "memory",
  PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "test-session-secret-at-least-thirty-two-characters",
  APP_ORIGIN: "http://localhost:3000",
  SMTP_PORT: 587,
  SMTP_SECURE: false
};

function cookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
}

describeDatabase("canonical Pawsh workflow", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  let ownerCookie: string;
  let businessId: string;
  let locationId: string;
  let employeeId: string;
  let serviceId: string;
  let customerId: string;
  let petId: string;
  let appointmentId: string;
  let invoiceId: string;
  let paymentId: string;
  let memberCookie: string;
  let memberMembershipId: string;
  let otherUserId: string;
  let otherBusinessId: string;
  let resetOwnerCookie: string;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("creates an owner, business, location, and protected session", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: `owner-${suffix}@example.test`, password: "correct horse battery staple", businessName: "Mochi & Co." }
    });
    expect(response.statusCode).toBe(201);
    ownerCookie = cookie(response);
    const signup = response.json();
    businessId = signup.businessId;
    locationId = signup.locationId;

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ businessId, isOwner: true });

    const settings = await app.inject({
      method: "PUT", url: "/api/business/settings",
      headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
      payload: {
        name: "Mochi & Co.", timezone: "America/Los_Angeles", currency: "USD",
        taxRateBasisPoints: 825, reminderLeadMinutes: 1440, locationVersion:1
      }
    });
    expect(settings.statusCode).toBe(200);
    const crossOrigin = await app.inject({
      method: "POST", url: "/api/auth/logout",
      headers: { cookie: ownerCookie, origin: "https://attacker.example" }
    });
    expect(crossOrigin.statusCode).toBe(403);
    const crossSite = await app.inject({
      method:"POST", url:"/api/auth/logout",
      headers:{ cookie:ownerCookie, "sec-fetch-site":"cross-site" }
    });
    expect(crossSite.statusCode).toBe(403);
  });

  it("keeps credential failures generic and applies bounded account throttling", async () => {
    const unknownEmail = `unknown-${suffix}@example.test`;
    const existing = await app.inject({
      method:"POST", url:"/api/auth/login",
      payload:{ email:`owner-${suffix}@example.test`, password:"not the owner password" }
    });
    const missing = await app.inject({
      method:"POST", url:"/api/auth/login",
      payload:{ email:unknownEmail, password:"not the owner password" }
    });
    expect(existing.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual(existing.json());

    for (let attempt = 1; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method:"POST", url:"/api/auth/login",
        payload:{ email:unknownEmail, password:"not the owner password" }
      });
      expect(response.statusCode).toBe(401);
    }
    const throttled = await app.inject({
      method:"POST", url:"/api/auth/login",
      payload:{ email:unknownEmail, password:"not the owner password" }
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBe("1");
    expect(throttled.json()).toEqual({ error:"Too many authentication attempts; try again later" });
  });

  it("keeps reset requests generic and throttles unknown accounts identically", async () => {
    const email = `reset-abuse-${suffix}@example.test`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method:"POST", url:"/api/auth/password-reset/request", payload:{ email }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted:true });
    }
    const throttled = await app.inject({
      method:"POST", url:"/api/auth/password-reset/request", payload:{ email }
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBe("1");
  });

  it("configures a service, employee, customer, and safety-aware pet", async () => {
    const service = await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name: "Full Groom", baseDurationMinutes: 60, basePriceMinor: 8500 }
    });
    expect(service.statusCode).toBe(201);
    serviceId = service.json().id;

    const employee = await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: "Jamie", serviceIds: [serviceId] }
    });
    expect(employee.statusCode).toBe(201);
    employeeId = employee.json().id;

    const customer = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: {
        firstName: "Pat", lastName: "Lee", email: `customer-${suffix}@example.test`,
        preferredContactMethod: "email", emailAllowed: true
      }
    });
    expect(customer.statusCode).toBe(201);
    customerId = customer.json().id;

    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Mochi", species: "dog", safetyAlerts: "Sensitive left hip" }
    });
    expect(pet.statusCode).toBe(201);
    petId = pet.json().id;
  });

  it("persists a tenant-scoped customer preferred groomer and uses it as a history fallback", async () => {
    const saved=await app.inject({method:"PATCH",url:`/api/customers/${customerId}/preferred-groomer`,
      headers:{cookie:ownerCookie},payload:{employeeId}});
    expect(saved.statusCode).toBe(200);
    const profile=await app.inject({method:"GET",url:`/api/customers/${customerId}/history`,headers:{cookie:ownerCookie}});
    expect(profile.statusCode).toBe(200);
    expect(profile.json().customer).toMatchObject({preferredEmployeeId:employeeId,preferredEmployeeName:"Jamie"});
    const defaults=await app.inject({method:"GET",url:`/api/pets/${petId}/booking-defaults`,headers:{cookie:ownerCookie}});
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().groomers).toEqual([expect.objectContaining({id:employeeId,displayName:"Jamie"})]);

    const patch=(payload:Record<string,unknown>)=>app.inject({method:"PATCH",
      url:`/api/customers/${customerId}/preferred-groomer`,headers:{cookie:ownerCookie},payload});
    expect((await patch({employeeId:"not-a-uuid"})).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({employeeId,unexpected:true})).statusCode).toBe(400);
    const unknown=await patch({employeeId:crypto.randomUUID()});
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("Choose an active groomer");
    const cleared=await patch({employeeId:null});
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().preferredEmployeeId).toBeNull();
    const clearedProfile=await app.inject({method:"GET",url:`/api/customers/${customerId}/history`,headers:{cookie:ownerCookie}});
    expect(clearedProfile.json().customer).toMatchObject({preferredEmployeeId:null,preferredEmployeeName:null});
    expect((await patch({employeeId})).statusCode).toBe(200);
    const missingCustomer=await app.inject({method:"PATCH",
      url:`/api/customers/${crypto.randomUUID()}/preferred-groomer`,headers:{cookie:ownerCookie},payload:{employeeId}});
    expect(missingCustomer.statusCode).toBe(404);
  });

  it("enforces half-open scheduling and database overlap protection", async () => {
    const create = () => app.inject({
      method: "POST", url: "/api/appointments", headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { locationId, customerId, petId, employeeId, serviceIds: [serviceId], localStart:"2031-08-01T09:00",expectedLocationVersion:2 }
    });
    const [first, racing] = await Promise.all([create(), create()]);
    expect([first.statusCode, racing.statusCode].sort()).toEqual([201, 409]);
    appointmentId = (first.statusCode === 201 ? first : racing).json().id;

    const adjacent = await app.inject({
      method: "POST", url: "/api/appointments", headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId, serviceIds: [serviceId],
        localStart: "2031-08-01T10:00", expectedLocationVersion:2
      }
    });
    expect(adjacent.statusCode).toBe(201);

    const hours = await app.inject({
      method: "PUT", url: `/api/employees/${employeeId}/working-hours`, headers: { cookie: ownerCookie },
      payload: { hours: [0,1,2,3,4,5,6].map((weekday) => ({ weekday, startTime: "09:00", endTime: "17:00" })) }
    });
    expect(hours.statusCode).toBe(204);
    const outsidePayload = {
      locationId, customerId, petId, employeeId, serviceIds: [serviceId],
      localStart: "2031-08-01T22:00", expectedLocationVersion:2
    };
    const unavailable = await app.inject({
      method: "POST", url: "/api/appointments", headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() }, payload: outsidePayload
    });
    // 22:00 against 09:00-17:00 hours. 409 with a NAMED reason, where this used to be a bare 400
    // reading "outside employee availability" - one sentence for a groomer's hours, the salon's
    // hours, a blocked time and a per-date unavailability alike. `canOverride` is what the
    // override attempt immediately below relies on.
    expect(unavailable.statusCode, unavailable.body).toBe(409);
    expect(unavailable.json()).toMatchObject({ code: "OUTSIDE_STAFF_HOURS", canOverride: true });
    const overridden = await app.inject({
      method: "POST", url: "/api/appointments", headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { ...outsidePayload, availabilityOverride: true, overrideReason: "Owner-approved after-hours request" }
    });
    expect(overridden.statusCode).toBe(201);
    const [overrideAudit] = await db<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where business_id=${businessId} and resource_id=${overridden.json().id}
        and reason='Owner-approved after-hours request'
    `;
    expect(overrideAudit?.count).toBe(1);
  });

  it("executes appointment operations and completes transactional checkout", async () => {
    for (const status of ["checked_in", "in_service", "completed"]) {
      const transition = await app.inject({
        method: "POST", url: `/api/appointments/${appointmentId}/transition`,
        headers: { cookie: ownerCookie }, payload: { status }
      });
      expect(transition.statusCode).toBe(200);
    }
    const invalid = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/transition`,
      headers: { cookie: ownerCookie }, payload: { status: "checked_in" }
    });
    expect(invalid.statusCode).toBe(400);

    const checkout = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() }, payload: { discountMinor: 500, discountType: "courtesy", tipMinor: 1500 }
    });
    expect(checkout.statusCode).toBe(201);
    expect(checkout.json()).toMatchObject({ subtotalMinor: 8500, totalMinor: 10160, balanceMinor: 10160 });
    invoiceId = checkout.json().id;
    const checkoutRetry = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() }, payload: { discountMinor: 500, discountType: "courtesy", tipMinor: 1500 }
    });
    expect(checkoutRetry.statusCode).toBe(200);
    expect(checkoutRetry.json().id).toBe(invoiceId);

    const overpayment = await app.inject({
      method: "POST", url: `/api/invoices/${invoiceId}/payments`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() }, payload: { amountMinor: 10161, expectedBalanceMinor: 10160, method: "cash" }
    });
    expect(overpayment.statusCode).toBe(400);

    const payment = await app.inject({
      method: "POST", url: `/api/invoices/${invoiceId}/payments`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() }, payload: { amountMinor: 10160, expectedBalanceMinor: 10160, method: "external_card" }
    });
    expect(payment.statusCode).toBe(201);
    paymentId = payment.json().id;

    const receipt = await app.inject({
      method: "GET", url: `/api/invoices/${invoiceId}/receipt`, headers: { cookie: ownerCookie }
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().invoice).toMatchObject({ status: "paid", balanceMinor: 0 });
    expect(receipt.json().payments).toHaveLength(1);
  });

  it("voids an incorrect manual record without claiming an external refund", async () => {
    const voided = await app.inject({
      method: "POST", url: `/api/payments/${paymentId}/void`, headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { reason: "Recorded against the wrong terminal receipt" }
    });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().balance).toBe(10160);

    const replacement = await app.inject({
      method: "POST", url: `/api/invoices/${invoiceId}/payments`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() }, payload: { amountMinor: 10160, expectedBalanceMinor: 10160, method: "external_card", externalReference: "corrected" }
    });
    expect(replacement.statusCode).toBe(201);

    const [audit] = await db<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where business_id=${businessId} and resource_id=${paymentId} and action='payment.void'
    `;
    expect(audit?.count).toBe(1);
  });

  it("creates notification intent once when outbox processing retries", async () => {
    // The CI validation command runs the complete suite before rerunning the
    // database suite, so an earlier pass can leave more than one worker batch
    // of unrelated events in this shared validation database. Drain batches
    // until this workflow's event is reached instead of assuming it is among
    // the first 25 globally queued events.
    for (let batch = 0; batch < 100; batch += 1) {
      await processOutbox(db);
      const [current] = await db<{ count: number }[]>`
        select count(*)::integer as count from notification_intents
        where business_id=${businessId} and appointment_id=${appointmentId}
          and notification_type='appointment_confirmation'
      `;
      if (current?.count === 1) break;
    }
    await processOutbox(db);
    const [count] = await db<{ count: number }[]>`
      select count(*)::integer as count from notification_intents
      where business_id=${businessId} and appointment_id=${appointmentId}
        and notification_type='appointment_confirmation'
    `;
    expect(count?.count).toBe(1);
  });

  it("lists and queues supported reminders without fabricating deferred types", async () => {
    const appointment=await app.inject({method:"GET",url:"/api/reminders?type=appointment_reminder",headers:{cookie:ownerCookie}});
    expect(appointment.statusCode).toBe(200);
    expect(appointment.json().supported).toBe(true);
    const item=appointment.json().items.find((candidate:{appointmentId:string})=>candidate.appointmentId===appointmentId);
    expect(item).toBeTruthy();
    const queued=await app.inject({method:"POST",url:`/api/reminders/${item.id}/send`,headers:{cookie:ownerCookie}});
    expect(queued.statusCode).toBe(202);
    const deferred=await app.inject({method:"GET",url:"/api/reminders?type=birthday_reminder",headers:{cookie:ownerCookie}});
    expect(deferred.json()).toEqual({supported:false,items:[]});
    const logs=await app.inject({method:"GET",url:`/api/reminders/${item.id}/logs`,headers:{cookie:ownerCookie}});
    expect(logs.statusCode).toBe(200);
    expect(logs.json()).toMatchObject({id:item.id,channel:"email",reminderStatus:expect.any(String)});
    expect(Array.isArray(logs.json().logs)).toBe(true);
    const missingLogs=await app.inject({method:"GET",url:`/api/reminders/${crypto.randomUUID()}/logs`,headers:{cookie:ownerCookie}});
    expect(missingLogs.statusCode).toBe(404);
  });

  it("serves bounded profile projections carrying service snapshots", async () => {
    const profile=await app.inject({method:"GET",url:`/api/customers/${customerId}/history`,headers:{cookie:ownerCookie}});
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({appointmentsTruncated:false,appointmentTotal:expect.any(Number)});
    // The profile splits the client's appointments into what is still ahead and what is settled,
    // so a booking is found across both lists rather than in one undivided array.
    const booked=[...profile.json().upcoming.items,...profile.json().history.items]
      .find((item:{id:string})=>item.id===appointmentId);
    expect(booked.services).toEqual([expect.objectContaining({name:"Full Groom",durationMinutes:60,priceMinor:8500})]);
    expect(booked.groomers).toEqual([expect.objectContaining({id:employeeId,displayName:"Jamie"})]);

    const page=await app.inject({method:"GET",
      url:`/api/customers/${customerId}/appointments?page=1&pageSize=10`,headers:{cookie:ownerCookie}});
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({page:1,pageSize:10,total:profile.json().appointmentTotal});

    const pet=await app.inject({method:"GET",url:`/api/pets/${petId}`,headers:{cookie:ownerCookie}});
    expect(pet.statusCode).toBe(200);
    expect(pet.json()).toMatchObject({id:petId,name:"Mochi",customerName:"Pat Lee",safetyAlerts:"Sensitive left hip"});

    const petHistory=await app.inject({method:"GET",url:`/api/pets/${petId}/appointments`,headers:{cookie:ownerCookie}});
    expect(petHistory.statusCode).toBe(200);
    expect(petHistory.json().items.every((item:{petId:string})=>item.petId===petId)).toBe(true);

    const availability=await app.inject({method:"GET",
      url:`/api/employees/${employeeId}/working-hours`,headers:{cookie:ownerCookie}});
    expect(availability.statusCode).toBe(200);
    expect(availability.json()).toHaveLength(7);
  });

  it("filters calendar and report projections by groomer", async () => {
    const assigned=await app.inject({method:"GET",
      url:`/api/appointments?localDate=2031-08-01&days=2&employeeIds=${employeeId}`,headers:{cookie:ownerCookie}});
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().some((item:{id:string})=>item.id===appointmentId)).toBe(true);
    const unassigned=await app.inject({method:"GET",
      url:`/api/appointments?localDate=2031-08-01&days=2&employeeIds=${crypto.randomUUID()}`,headers:{cookie:ownerCookie}});
    expect(unassigned.json()).toEqual([]);

    const reports=await app.inject({method:"GET",
      url:`/api/reports?localDate=2031-08-01&days=2&employeeIds=${employeeId}`,headers:{cookie:ownerCookie}});
    expect(reports.statusCode).toBe(200);
    expect(reports.json().totals).toMatchObject({completedAppointments:1,servicesPerformed:1});
    expect(reports.json().employees.every((row:{id:string})=>row.id===employeeId)).toBe(true);
    const otherGroomer=await app.inject({method:"GET",
      url:`/api/reports?localDate=2031-08-01&days=2&employeeIds=${crypto.randomUUID()}`,headers:{cookie:ownerCookie}});
    // Exact shape on purpose: a groomer with no work must produce a fully zeroed dashboard, and a new
    // aggregate that forgets the groomer filter would surface here as an unexpected non-zero key.
    expect(otherGroomer.json().totals).toEqual({
      paidRevenueMinor:0,completedAppointments:0,servicesPerformed:0,totalPets:0,
      expectedRevenueMinor:0,outstandingMinor:0,billedRevenueMinor:0,salesMinor:0,
      discountMinor:0,netMinor:0,taxMinor:0,tipMinor:0,unattributedRevenueMinor:0,
      unattributedTipMinor:0,commissionMinor:null,
      // Refunds are reported beside collected money rather than netted into it, so they are four
      // more keys that must zero out under the groomer filter like every other aggregate here.
      refundedMinor:0,refundedTipMinor:0,refundCount:0,netCollectedMinor:0
    });
    const invalid=await app.inject({method:"GET",url:"/api/reports?employeeIds=not-a-uuid",headers:{cookie:ownerCookie}});
    expect(invalid.statusCode).toBe(400);
  });

  it("atomically claims notification delivery across concurrent workers", async () => {
    const sent: EmailMessage[] = [];
    const provider: EmailProvider = {
      async send(message) {
        sent.push(message);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { providerReference: `test:${message.idempotencyKey}` };
      }
    };
    await Promise.all([
      deliverNotifications(db, provider),
      deliverNotifications(db, provider),
      deliverNotifications(db, provider)
    ]);
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent.map((message) => message.idempotencyKey)).size).toBe(sent.length);
    const [intent] = await db<{ status: string; attempts: number }[]>`
      select status,attempts from notification_intents
      where business_id=${businessId} and appointment_id=${appointmentId}
        and notification_type='appointment_confirmation'
    `;
    expect(intent).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("preserves notification claim, retry, stale recovery, and delivered invariants", async () => {
    const insertIntent = async (status = "pending", stale = false) => {
      const [intent] = await db<{ id: string }[]>`
        insert into notification_intents
          (business_id,notification_type,scheduled_occurrence,channel,destination,status,updated_at)
        values (
          ${businessId},${`worker_regression_${crypto.randomUUID()}`},now(),'email',
          ${`worker-${suffix}@example.test`},${status},
          ${stale ? new Date(Date.now() - 11 * 60_000) : new Date()}
        )
        returning id
      `;
      return intent!.id;
    };
    const sent: string[] = [];
    const successfulProvider: EmailProvider = {
      async send(message) {
        sent.push(message.idempotencyKey);
        return { providerReference: `test:${message.idempotencyKey}` };
      }
    };

    const singleWorkerId = await insertIntent();
    await deliverNotifications(db, successfulProvider);
    expect(sent.filter((id) => id === singleWorkerId)).toHaveLength(1);

    const freshClaimId = await insertIntent("sending");
    await deliverNotifications(db, successfulProvider);
    expect(sent).not.toContain(freshClaimId);

    const staleClaimId = await insertIntent("sending", true);
    await deliverNotifications(db, successfulProvider);
    expect(sent.filter((id) => id === staleClaimId)).toHaveLength(1);

    const retryId = await insertIntent();
    const failingProvider: EmailProvider = {
      async send() {
        throw new Error("deterministic provider failure");
      }
    };
    await deliverNotifications(db, failingProvider);
    const [failed] = await db<{ status: string; attempts: number }[]>`
      select status,attempts from notification_intents where id=${retryId}
    `;
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    await deliverNotifications(db, successfulProvider);
    const [retried] = await db<{ status: string; attempts: number }[]>`
      select status,attempts from notification_intents where id=${retryId}
    `;
    expect(retried).toMatchObject({ status: "sent", attempts: 2 });
    expect(sent.filter((id) => id === retryId)).toHaveLength(1);

    const deliveredId = await insertIntent("sent");
    await deliverNotifications(db, successfulProvider);
    expect(sent).not.toContain(deliveredId);
  });

  it("distinguishes an initial reminder attempt from a retry and never leaks provider detail", async () => {
    const [intent] = await db<{ id: string }[]>`
      insert into notification_intents
        (business_id,appointment_id,customer_id,notification_type,scheduled_occurrence,channel,destination,status,attempts)
      values (${businessId},${appointmentId},${customerId},'appointment_reminder',now(),'email',
        ${`reminder-log-${suffix}@example.test`},'failed',2)
      returning id
    `;
    await db`
      insert into notification_delivery_attempts(business_id,notification_intent_id,attempt_number,outcome,error)
      values (${businessId},${intent!.id},1,'failed','smtp 550 mailbox unavailable'),
             (${businessId},${intent!.id},2,'failed','provider-token-should-not-leak')
    `;
    const logs = await app.inject({
      method: "GET", url: `/api/reminders/${intent!.id}/logs`, headers: { cookie: ownerCookie }
    });
    expect(logs.statusCode).toBe(200);
    expect(logs.json()).toMatchObject({ id: intent!.id, channel: "email", reminderStatus: "failed", attempts: 2 });
    const attempts = logs.json().logs as { attemptNumber: number; attemptKind: string; safeFailureReason: string | null }[];
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([2, 1]);
    expect(attempts.find((attempt) => attempt.attemptNumber === 1)?.attemptKind).toBe("initial");
    expect(attempts.find((attempt) => attempt.attemptNumber === 2)?.attemptKind).toBe("retry");
    expect(attempts.every((attempt) => attempt.safeFailureReason === "Delivery failed")).toBe(true);
    expect(logs.body).not.toContain("smtp 550");
    expect(logs.body).not.toContain("provider-token-should-not-leak");

    // A failed reminder below the attempt ceiling can be resent through the same endpoint.
    const resent = await app.inject({
      method: "POST", url: `/api/reminders/${intent!.id}/send`, headers: { cookie: ownerCookie }
    });
    expect(resent.statusCode).toBe(202);

    // Exhausted reminders stop offering a send instead of retrying forever.
    await db`update notification_intents set status='failed',attempts=5 where business_id=${businessId} and id=${intent!.id}`;
    const exhausted = await app.inject({
      method: "POST", url: `/api/reminders/${intent!.id}/send`, headers: { cookie: ownerCookie }
    });
    expect(exhausted.statusCode).toBe(409);

    const foreign = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: `reminder-log-foreign-${suffix}@example.test`, password: "correct horse reminder logs", businessName: "Reminder Log Foreign" }
    });
    const crossTenant = await app.inject({
      method: "GET", url: `/api/reminders/${intent!.id}/logs`, headers: { cookie: cookie(foreign) }
    });
    expect(crossTenant.statusCode).toBe(404);
  });

  it("supports invitation acceptance and enforces customized permission denial", async () => {
    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email: `groomer-${suffix}@example.test`, roleId: await createRole(app, ownerCookie, `Groomer ${suffix}`, ["calendar.view"]) }
    });
    expect(invitation.statusCode).toBe(201);
    const token = new URL(invitation.json().acceptancePath, "http://localhost").searchParams.get("invite");
    expect(token).toBeTruthy();

    const accepted = await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: "another correct horse battery" }
    });
    expect(accepted.statusCode).toBe(200);
    memberCookie = cookie(accepted);

    const denied = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: memberCookie },
      payload: { firstName: "Denied", lastName: "Write" }
    });
    expect(denied.statusCode).toBe(403);
    const members = await app.inject({ method: "GET", url: "/api/members", headers: { cookie: ownerCookie } });
    memberMembershipId = members.json().find((member: { email: string }) => member.email.startsWith("groomer-")).id;
  });

  it("denies cross-tenant resource access", async () => {
    const other = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: `other-${suffix}@example.test`, password: "correct horse other tenant", businessName: "Other Salon" }
    });
    expect(other.statusCode).toBe(201);
    otherUserId = other.json().userId;
    otherBusinessId = other.json().businessId;
    const existingInvitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email: `other-${suffix}@example.test`, roleId: await createRole(app, ownerCookie, `Other ${suffix}`, ["calendar.view"]) }
    });
    const existingToken = new URL(existingInvitation.json().acceptancePath, "http://localhost").searchParams.get("invite");
    const wrongPassword = await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token: existingToken, password: "this must not replace the password" }
    });
    expect(wrongPassword.statusCode).toBe(400);
    const existingAccepted = await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token: existingToken, password: "correct horse other tenant" }
    });
    expect(existingAccepted.statusCode).toBe(200);
    const response = await app.inject({
      method: "GET", url: `/api/customers/${customerId}/history`, headers: { cookie: cookie(other) }
    });
    expect(response.statusCode).toBe(404);
    const preferred=await app.inject({method:"PATCH",url:`/api/customers/${customerId}/preferred-groomer`,
      headers:{cookie:cookie(other)},payload:{employeeId:null}});
    expect(preferred.statusCode).toBe(404);
    const reminders=await app.inject({method:"GET",url:"/api/reminders?type=appointment_reminder",headers:{cookie:cookie(other)}});
    expect(reminders.statusCode).toBe(200);
    expect(reminders.json().items.every((item:{appointmentId:string})=>item.appointmentId!==appointmentId)).toBe(true);
    for(const url of [
      `/api/customers/${customerId}/appointments`,
      `/api/pets/${petId}`,
      `/api/pets/${petId}/appointments`,
      `/api/employees/${employeeId}/working-hours`
    ]){
      const foreign=await app.inject({method:"GET",url,headers:{cookie:cookie(other)}});
      expect(foreign.statusCode,url).toBe(404);
    }
    const foreignFilter=await app.inject({method:"GET",
      url:`/api/appointments?localDate=2031-08-01&days=2&employeeIds=${employeeId}`,headers:{cookie:cookie(other)}});
    expect(foreignFilter.statusCode).toBe(200);
    expect(foreignFilter.json()).toEqual([]);
  });

  it("transfers protected ownership without leaving the business ownerless", async () => {
    // The transfer states what the outgoing owner keeps. There is no default: without a role the
    // founder would become a non-owner holding nothing.
    // The role the founder keeps carries the full tuple, because the rest of this suite goes on
    // using their session: the transfer changes who OWNS the workspace, and this suite is not the
    // place to also change what that person can reach. `roles-api.test.ts` is where the narrow case
    // is pinned down.
    const keptRole = await createRole(app, ownerCookie, `Former owner ${suffix}`, [...permissions]);
    expect((await app.inject({
      method: "POST", url: "/api/business/transfer-ownership", headers: { cookie: ownerCookie },
      payload: { membershipId: memberMembershipId }
    })).statusCode).toBe(400);
    const transfer = await app.inject({
      method: "POST", url: "/api/business/transfer-ownership", headers: { cookie: ownerCookie },
      payload: { membershipId: memberMembershipId, outgoingOwnerRoleId: keptRole }
    });
    expect(transfer.statusCode).toBe(200);
    const formerOwner = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } });
    const newOwner = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: memberCookie } });
    expect(formerOwner.json().isOwner).toBe(false);
    expect(newOwner.json().isOwner).toBe(true);
    // The founder landed on the named role rather than on nothing at all.
    expect(formerOwner.json().role).toMatchObject({ id: keptRole, enabled: true });
    expect(formerOwner.json().permissions.length).toBeGreaterThan(0);
    expect(newOwner.json().role).toBeNull();
  });

  it("resets passwords with a short-lived token and revokes existing sessions", async () => {
    const requested = await app.inject({
      method: "POST", url: "/api/auth/password-reset/request",
      payload: { email: `owner-${suffix}@example.test` }
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json().developmentToken).toBeTruthy();
    const [resetIntent] = await db<{ encryptedBody: string }[]>`
      select encrypted_body from notification_intents
      where business_id=${businessId} and notification_type='password_reset'
      order by created_at desc limit 1
    `;
    expect(resetIntent?.encryptedBody).toBeTruthy();
    expect(resetIntent?.encryptedBody).not.toContain(requested.json().developmentToken);
    expect(openSecret(resetIntent!.encryptedBody, config.SESSION_SECRET))
      .toContain(requested.json().developmentToken);
    const confirmed = await app.inject({
      method: "POST", url: "/api/auth/password-reset/confirm",
      payload: { token: requested.json().developmentToken, password: "new secure owner password" }
    });
    expect(confirmed.statusCode).toBe(200);
    const revoked = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } });
    expect(revoked.statusCode).toBe(401);
    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { email: `owner-${suffix}@example.test`, password: "new secure owner password" }
    });
    expect(login.statusCode).toBe(200);
    resetOwnerCookie = cookie(login);
  });

  it("restricts exact-id platform support and audits disable actions", async () => {
    const support = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `support-${suffix}@example.test`,
        password: "correct horse support identity",
        businessName: "Pawsh Support Fixture"
      }
    });
    expect(support.statusCode).toBe(201);
    const supportCookie = cookie(support);
    const supportUserId = support.json().userId;
    await db`insert into platform_administrators(user_id) values (${supportUserId})`;
    const business = await app.inject({
      method: "GET", url: `/api/admin/businesses/${otherBusinessId}`, headers: { cookie: supportCookie }
    });
    expect(business.statusCode).toBe(200);
    const user = await app.inject({
      method: "GET", url: `/api/admin/users/${otherUserId}`, headers: { cookie: supportCookie }
    });
    expect(user.statusCode).toBe(200);
    const disabled = await app.inject({
      method: "POST", url: `/api/admin/users/${otherUserId}/disable`, headers: { cookie: supportCookie },
      payload: { reason: "Security response test account disable" }
    });
    expect(disabled.statusCode).toBe(200);
    const [audit] = await db<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where actor_id=${supportUserId} and resource_id=${otherUserId} and action='platform.user.disable'
    `;
    expect(audit?.count).toBe(1);
  });

  it("keeps critical read paths within the documented CI latency budget", async () => {
    const measurements: Record<string, number[]> = {
      dashboard: [],
      calendar: [],
      customerSearch: []
    };
    const requests = [
      ["dashboard", "/api/dashboard"],
      ["calendar", "/api/appointments?localDate=2031-08-01&days=7"],
      ["customerSearch", "/api/customers?search=Pat"]
    ] as const;
    for (let iteration = 0; iteration < 10; iteration += 1) {
      for (const [name, url] of requests) {
        const started = performance.now();
        const response = await app.inject({ method: "GET", url, headers: { cookie: resetOwnerCookie } });
        measurements[name]!.push(performance.now() - started);
        expect(response.statusCode).toBe(200);
      }
    }
    for (const values of Object.values(measurements)) {
      const sorted = [...values].sort((left, right) => left - right);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
      expect(p95).toBeLessThan(1_000);
    }
  });
});
