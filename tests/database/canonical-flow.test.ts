import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { deliverNotifications, processOutbox, type EmailMessage, type EmailProvider } from "../../src/engagement/worker.js";
import { openSecret } from "../../src/security/secrets.js";

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
      method: "PUT", url: "/api/business/settings", headers: { cookie: ownerCookie },
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

  it("enforces half-open scheduling and database overlap protection", async () => {
    const startAt = "2031-08-01T16:00:00.000Z";
    const create = () => app.inject({
      method: "POST", url: "/api/appointments", headers: { cookie: ownerCookie },
      payload: { locationId, customerId, petId, employeeId, serviceIds: [serviceId], startAt }
    });
    const [first, racing] = await Promise.all([create(), create()]);
    expect([first.statusCode, racing.statusCode].sort()).toEqual([201, 409]);
    appointmentId = (first.statusCode === 201 ? first : racing).json().id;

    const adjacent = await app.inject({
      method: "POST", url: "/api/appointments", headers: { cookie: ownerCookie },
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
      method: "POST", url: "/api/appointments", headers: { cookie: ownerCookie }, payload: outsidePayload
    });
    expect(unavailable.statusCode).toBe(400);
    const overridden = await app.inject({
      method: "POST", url: "/api/appointments", headers: { cookie: ownerCookie },
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
    await processOutbox(db);
    await processOutbox(db);
    const [count] = await db<{ count: number }[]>`
      select count(*)::integer as count from notification_intents
      where business_id=${businessId} and appointment_id=${appointmentId}
        and notification_type='appointment_confirmation'
    `;
    expect(count?.count).toBe(1);
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

  it("supports invitation acceptance and enforces customized permission denial", async () => {
    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email: `groomer-${suffix}@example.test`, permissions: ["calendar.view"] }
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
      payload: { email: `other-${suffix}@example.test`, permissions: ["calendar.view"] }
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
  });

  it("transfers protected ownership without leaving the business ownerless", async () => {
    const transfer = await app.inject({
      method: "POST", url: "/api/business/transfer-ownership", headers: { cookie: ownerCookie },
      payload: { membershipId: memberMembershipId }
    });
    expect(transfer.statusCode).toBe(200);
    const formerOwner = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } });
    const newOwner = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: memberCookie } });
    expect(formerOwner.json().isOwner).toBe(false);
    expect(newOwner.json().isOwner).toBe(true);
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
