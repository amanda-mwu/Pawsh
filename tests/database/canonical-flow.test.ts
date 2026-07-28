import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { deliverNotifications, processOutbox, type EmailMessage, type EmailProvider } from "../../src/engagement/worker.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "test-session-secret-at-least-thirty-two-characters",
  APP_ORIGIN: "http://localhost:3000"
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
        taxRateBasisPoints: 825, reminderLeadMinutes: 1440
      }
    });
    expect(settings.statusCode).toBe(200);
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

    const payment = await app.inject({
      method: "POST", url: `/api/invoices/${invoiceId}/payments`,
      headers: { cookie: ownerCookie }, payload: { amountMinor: 10160, method: "external_card" }
    });
    expect(payment.statusCode).toBe(201);

    const receipt = await app.inject({
      method: "GET", url: `/api/invoices/${invoiceId}/receipt`, headers: { cookie: ownerCookie }
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().invoice).toMatchObject({ status: "paid", balanceMinor: 0 });
    expect(receipt.json().payments).toHaveLength(1);
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
    const memberCookie = cookie(accepted);

    const denied = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: memberCookie },
      payload: { firstName: "Denied", lastName: "Write" }
    });
    expect(denied.statusCode).toBe(403);
  });

  it("denies cross-tenant resource access", async () => {
    const other = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: `other-${suffix}@example.test`, password: "correct horse other tenant", businessName: "Other Salon" }
    });
    expect(other.statusCode).toBe(201);
    const response = await app.inject({
      method: "GET", url: `/api/customers/${customerId}/history`, headers: { cookie: cookie(other) }
    });
    expect(response.statusCode).toBe(404);
  });
});
