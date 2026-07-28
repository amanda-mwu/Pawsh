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
  let ownerUserId: string;
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
    ownerUserId = signup.userId;
    businessId = signup.businessId;
    locationId = signup.locationId;

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ businessId, isOwner: true });

    const settings = await app.inject({
      method: "PUT", url: "/api/business/settings", headers: { cookie: ownerCookie },
      payload: {
        name: "Mochi & Co.", timezone: "America/Los_Angeles", currency: "USD",
        taxRateBasisPoints: 825, reminderLeadMinutes: 1440
      }
    });
    expect(settings.statusCode).toBe(200);
    const crossOrigin = await app.inject({
      method: "POST", url: "/api/auth/logout",
      headers: { cookie: ownerCookie, origin: "https://attacker.example" }
    });
    expect(crossOrigin.statusCode).toBe(403);
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
        startAt: "2031-08-01T17:00:00.000Z"
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
      startAt: "2031-08-02T05:00:00.000Z"
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
      headers: { cookie: ownerCookie }, payload: { discountMinor: 500, discountType: "courtesy", tipMinor: 1500 }
    });
    expect(checkout.statusCode).toBe(201);
    expect(checkout.json()).toMatchObject({ subtotalMinor: 8500, totalMinor: 10160, balanceMinor: 10160 });
    invoiceId = checkout.json().id;
    const checkoutRetry = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
      headers: { cookie: ownerCookie }, payload: { discountMinor: 500, discountType: "courtesy", tipMinor: 1500 }
    });
    expect(checkoutRetry.statusCode).toBe(201);
    expect(checkoutRetry.json().id).toBe(invoiceId);

    const overpayment = await app.inject({
      method: "POST", url: `/api/invoices/${invoiceId}/payments`,
      headers: { cookie: ownerCookie }, payload: { amountMinor: 10161, method: "cash" }
    });
    expect(overpayment.statusCode).toBe(400);

    const payment = await app.inject({
      method: "POST", url: `/api/invoices/${invoiceId}/payments`,
      headers: { cookie: ownerCookie }, payload: { amountMinor: 10160, method: "external_card" }
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
      method: "POST", url: `/api/payments/${paymentId}/void`, headers: { cookie: ownerCookie },
      payload: { reason: "Recorded against the wrong terminal receipt" }
    });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().balance).toBe(10160);

    const replacement = await app.inject({
      method: "POST", url: `/api/invoices/${invoiceId}/payments`,
      headers: { cookie: ownerCookie }, payload: { amountMinor: 10160, method: "external_card", externalReference: "corrected" }
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
    await Promise.all([deliverNotifications(db, provider), deliverNotifications(db, provider)]);
    expect(sent).toHaveLength(1);
    const [intent] = await db<{ status: string; attempts: number }[]>`
      select status,attempts from notification_intents
      where business_id=${businessId} and appointment_id=${appointmentId}
        and notification_type='appointment_confirmation'
    `;
    expect(intent).toMatchObject({ status: "sent", attempts: 1 });
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
    const [resetIntent] = await db<{ encrypted_body: string }[]>`
      select encrypted_body from notification_intents
      where business_id=${businessId} and notification_type='password_reset'
      order by created_at desc limit 1
    `;
    expect(resetIntent?.encrypted_body).toBeTruthy();
    expect(resetIntent?.encrypted_body).not.toContain(requested.json().developmentToken);
    expect(openSecret(resetIntent!.encrypted_body, config.SESSION_SECRET))
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
    await db`insert into platform_administrators(user_id) values (${ownerUserId})`;
    const business = await app.inject({
      method: "GET", url: `/api/admin/businesses/${otherBusinessId}`, headers: { cookie: resetOwnerCookie }
    });
    expect(business.statusCode).toBe(200);
    const user = await app.inject({
      method: "GET", url: `/api/admin/users/${otherUserId}`, headers: { cookie: resetOwnerCookie }
    });
    expect(user.statusCode).toBe(200);
    const disabled = await app.inject({
      method: "POST", url: `/api/admin/users/${otherUserId}/disable`, headers: { cookie: resetOwnerCookie },
      payload: { reason: "Security response test account disable" }
    });
    expect(disabled.statusCode).toBe(200);
    const [audit] = await db<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where actor_id=${ownerUserId} and resource_id=${otherUserId} and action='platform.user.disable'
    `;
    expect(audit?.count).toBe(1);
  });
});
