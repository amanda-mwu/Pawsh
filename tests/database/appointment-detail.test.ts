import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { protectedPetCareFields } from "@pawsh/domain";
import { roleFor } from "../support/roles.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "appointment-detail-secret-at-least-32-characters",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

const localDate = "2034-06-12";

/**
 * The detail endpoint exists so a detail screen can refetch one visit. Its whole contract is that
 * the record it returns is the same record the calendar list returned, so the parity assertion
 * below compares the two whole rows rather than a hand-picked subset of fields.
 */
describeDatabase("single appointment detail", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  const ownerEmail = `detail-${suffix}@example.test`;
  let ownerCookie: string;
  let limitedCookie: string;
  let businessId: string;
  let locationId: string;
  let appointmentId: string;
  let rivalCookie: string;
  let rivalAppointmentId: string;

  const bookInto = async (
    sessionCookie: string,
    ids: { locationId: string; customerId: string; petId: string; employeeId: string; serviceId: string },
    start: string
  ) => {
    const booking = await app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: sessionCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId: ids.locationId, customerId: ids.customerId, petId: ids.petId,
        employeeId: ids.employeeId, serviceIds: [ids.serviceId],
        localStart: start, expectedLocationVersion: 1
      }
    });
    expect(booking.statusCode, booking.body).toBe(201);
    return booking.json().id as string;
  };

  const provision = async (sessionCookie: string, label: string, petCare: Record<string, unknown> = {}) => {
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: sessionCookie }, payload });
    const serviceId = (await post("/api/services", {
      name: `${label} Groom`, baseDurationMinutes: 60, basePriceMinor: 6500
    })).json().id as string;
    const employeeId = (await post("/api/employees", {
      displayName: `${label} Groomer`, serviceIds: [serviceId]
    })).json().id as string;
    const customerId = (await post("/api/customers", {
      firstName: label, lastName: "Client", phone: "555-0100"
    })).json().id as string;
    const petId = (await post("/api/pets", {
      customerId, name: `${label} Pet`, species: "dog", breed: "Poodle", ...petCare
    })).json().id as string;
    return { serviceId, employeeId, customerId, petId };
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: ownerEmail, password: "correct horse detail battery", businessName: "Detail Salon"
    }});
    expect(signup.statusCode).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());
    const own = await provision(ownerCookie, "Detail", {
      safetyAlerts: "Nips at the dryer", medicalNotes: "On thyroid medication",
      behaviorNotes: "Settles once brushed"
    });
    appointmentId = await bookInto(ownerCookie, { locationId, ...own }, `${localDate}T09:00`);

    const limitedEmail = `detail-limited-${suffix}@example.test`;
    const limitedPassword = "correct horse limited battery";
    const [limitedUser] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash,display_name)
      values (${limitedEmail},${limitedEmail},${await hashPassword(limitedPassword)},'Limited') returning id
    `;
    await db`
      insert into business_memberships(business_id,user_id,role_id)
      values (${businessId},${limitedUser!.id},${await roleFor(db, businessId, ["calendar.view", "appointments.view"])})
    `;
    limitedCookie = cookie(await app.inject({
      method: "POST", url: "/api/auth/login", payload: { email: limitedEmail, password: limitedPassword }
    }));

    const rival = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `detail-rival-${suffix}@example.test`,
      password: "correct horse rival battery", businessName: "Rival Detail Salon"
    }});
    rivalCookie = cookie(rival);
    const rivalIds = await provision(rivalCookie, "Rival");
    rivalAppointmentId = await bookInto(
      rivalCookie, { locationId: rival.json().locationId, ...rivalIds }, `${localDate}T10:00`
    );
  });
  afterAll(async () => { await app.close(); await db.end(); });

  const listRow = async (sessionCookie: string, id: string) => {
    const list = await app.inject({
      method: "GET", url: `/api/appointments?localDate=${localDate}&days=1`,
      headers: { cookie: sessionCookie }
    });
    expect(list.statusCode, list.body).toBe(200);
    const rows = list.json() as { id: string }[];
    const row = rows.find((candidate) => candidate.id === id);
    expect(row).toBeDefined();
    return row!;
  };
  const detailRow = (sessionCookie: string, id: string) =>
    app.inject({ method: "GET", url: `/api/appointments/${id}`, headers: { cookie: sessionCookie } });

  it("returns exactly the list element for the same appointment", async () => {
    const detail = await detailRow(ownerCookie, appointmentId);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toEqual(await listRow(ownerCookie, appointmentId));
  });

  it("carries the joined customer, pet, staffing, service and invoice fields", async () => {
    const row = (await detailRow(ownerCookie, appointmentId)).json();
    expect(row).toMatchObject({
      id: appointmentId, businessId, locationId,
      firstName: "Detail", lastName: "Client", customerPhone: "555-0100",
      petName: "Detail Pet", breed: "Poodle", employeeName: "Detail Groomer"
    });
    expect(row.groomers).toEqual([{ id: expect.any(String), displayName: "Detail Groomer" }]);
    expect(row.services).toEqual([{
      id: expect.any(String), name: "Detail Groom", durationMinutes: 60,
      priceMinor: 6500, serviceId: expect.any(String)
    }]);
    expect(row).toHaveProperty("invoiceStatus");
    expect(row).toHaveProperty("invoiceBalanceMinor");
    expect(row.rabiesAppointmentStatus).toBe("not_provided");
  });

  it("redacts pet care for a caller without pets.care.view, exactly as the list does", async () => {
    const detail = await detailRow(limitedCookie, appointmentId);
    expect(detail.statusCode, detail.body).toBe(200);
    const row = detail.json();
    expect(row.safetyAlerts).toBeNull();
    expect(row.medicalNotes).toBeNull();
    expect(row.behaviorNotes).toBeNull();
    for (const field of protectedPetCareFields) {
      if (field in row) expect(row[field]).toBeNull();
    }
    // Non-care fields survive the redaction, so the screen still has something to render.
    expect(row.petName).toBe("Detail Pet");
    expect(detail.json()).toEqual(await listRow(limitedCookie, appointmentId));
    // And the owner still sees the care fields, so the assertion above is not vacuous.
    const ownerRow = (await detailRow(ownerCookie, appointmentId)).json();
    expect(ownerRow.safetyAlerts).toBe("Nips at the dryer");
    expect(ownerRow.medicalNotes).toBe("On thyroid medication");
  });

  it("404s for an appointment owned by another business", async () => {
    const crossTenant = await detailRow(ownerCookie, rivalAppointmentId);
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toEqual({ error: "Appointment not found" });
    // The rival can read its own row, so the 404 is tenant scoping rather than a missing record.
    expect((await detailRow(rivalCookie, rivalAppointmentId)).statusCode).toBe(200);
  });

  it("404s for an unknown id and rejects a malformed one", async () => {
    const unknown = await detailRow(ownerCookie, crypto.randomUUID());
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "Appointment not found" });
    expect((await detailRow(ownerCookie, "not-a-uuid")).statusCode).toBe(400);
  });

  it("requires authentication and the appointments.view permission", async () => {
    const anonymous = await app.inject({ method: "GET", url: `/api/appointments/${appointmentId}` });
    expect(anonymous.statusCode).toBe(401);
    await db`
      update business_memberships set role_id=${await roleFor(db, businessId, ["calendar.view"])}
      where business_id=${businessId} and not is_owner
    `;
    const forbidden = await detailRow(limitedCookie, appointmentId);
    expect(forbidden.statusCode).toBe(403);
    await db`
      update business_memberships set role_id=${await roleFor(db, businessId, ["calendar.view", "appointments.view"])}
      where business_id=${businessId} and not is_owner
    `;
  });
});
