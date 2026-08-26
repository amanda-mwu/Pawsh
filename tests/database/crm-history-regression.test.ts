import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";

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

describeDatabase("D3 customer, pet, and history regression", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string;
  let historyCookie: string;
  let careCookie: string;
  let editorCookie: string;
  let businessId: string;
  let locationId: string;
  let customerId: string;
  let petId: string;
  let employeeId: string;
  let serviceId: string;
  const suffix = crypto.randomUUID();

  const createMember = async (label: string, permissions: string[]) => {
    const email = `${label}-${suffix}@example.test`;
    const password = `correct horse ${label} battery`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash)
      values (${email},${email},${await hashPassword(password)}) returning id
    `;
    await db`
      insert into business_memberships(business_id,user_id,permissions)
      values (${businessId},${user!.id},${permissions})
    `;
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { email, password }
    });
    expect(login.statusCode).toBe(200);
    return cookie(login);
  };

  const profilePayload = (pet: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    customerId: pet.customerId,
    name: pet.name,
    species: pet.species,
    breed: pet.breed,
    dateOfBirth: pet.dateOfBirth,
    approximateAge: pet.approximateAge,
    weightOunces: pet.weightOunces,
    sex: pet.sex,
    coatNotes: pet.coatNotes,
    groomingPreferences: pet.groomingPreferences,
    photoPermission: pet.photoPermission,
    version: pet.version,
    ...overrides
  });

  const careAuditCount = async () => {
    const [row] = await db<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where business_id=${businessId} and resource_id=${petId}
        and action='pet.care.update'
    `;
    return row!.count;
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        email: `d3-owner-${suffix}@example.test`,
        password: "correct horse d3 owner battery",
        businessName: "D3 CRM"
      }
    });
    expect(signup.statusCode).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());

    const customer = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: {
        firstName: "D3", lastName: "Customer", phone: "6265550199",
        email: `customer-${suffix}@example.test`, address: "10 Pilot Way",
        preferredContactMethod: "email", emailAllowed: true, notes: "Preserve me"
      }
    });
    customerId = customer.json().id;
    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: {
        customerId, name: "D3 Pet", species: "dog", breed: "Terrier",
        groomingPreferences: "Short trim", safetyAlerts: "Use basket muzzle",
        medicalNotes: "Hip sensitivity", vaccinationExpiresOn: "2035-04-12"
      }
    });
    expect(pet.statusCode).toBe(201);
    petId = pet.json().id;
    const service = await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name: "Historic Groom", baseDurationMinutes: 50, basePriceMinor: 7000 }
    });
    serviceId = service.json().id;
    const employee = await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: "Current Groomer", serviceIds: [serviceId] }
    });
    employeeId = employee.json().id;

    historyCookie = await createMember("history", ["customers.view"]);
    careCookie = await createMember("care", [
      "customers.view", "pets.view", "pets.edit", "pets.care.view", "pets.care.edit"
    ]);
    editorCookie = await createMember("editor", ["customers.view", "pets.view", "pets.edit"]);
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("redacts protected history and enforces distinct profile and safety updates", async () => {
    const redacted = await app.inject({
      method: "GET", url: `/api/customers/${customerId}/history`,
      headers: { cookie: historyCookie }
    });
    expect(redacted.statusCode).toBe(200);
    expect(redacted.json().pets[0]).toMatchObject({
      safetyAlerts: null, medicalNotes: null, behaviorNotes: null,
      emergencyContact: null, veterinarian: null, vaccinationNotes: null,
      vaccinationExpiresOn: null
    });
    expect(redacted.json().invoices).toEqual([]);

    const visible = await app.inject({
      method: "GET", url: `/api/customers/${customerId}/history`,
      headers: { cookie: careCookie }
    });
    expect(visible.json().pets[0].safetyAlerts).toBe("Use basket muzzle");

    const current = visible.json().pets[0] as Record<string, unknown>;
    const profile = await app.inject({
      method: "PUT", url: `/api/pets/${petId}`, headers: { cookie: editorCookie },
      payload: profilePayload(current, { breed: "Border Terrier" })
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({
      breed: "Border Terrier", safetyAlerts: null, version: Number(current.version) + 1
    });
    const [preserved] = await db<{ safetyAlerts: string; medicalNotes: string }[]>`
      select safety_alerts,medical_notes from pets where business_id=${businessId} and id=${petId}
    `;
    expect(preserved).toMatchObject({
      safetyAlerts: "Use basket muzzle", medicalNotes: "Hip sensitivity"
    });
    expect(await careAuditCount()).toBe(0);

    const forbidden = await app.inject({
      method: "PUT", url: `/api/pets/${petId}/care`, headers: { cookie: editorCookie },
      payload: { version: profile.json().version, safetyAlerts: "Unauthorized" }
    });
    expect(forbidden.statusCode).toBe(403);
    expect(await careAuditCount()).toBe(0);

    const missingVersion = await app.inject({
      method: "PUT", url: `/api/pets/${petId}/care`, headers: { cookie: careCookie },
      payload: { safetyAlerts: "Missing version" }
    });
    expect(missingVersion.statusCode).toBe(400);
  });

  it("authorizes preferred groomer writes by permission and exposes the read through the profile projection", async () => {
    // customers.edit is the write gate; customers.view alone is enough to read the field back.
    const denied = await app.inject({
      method: "PATCH", url: `/api/customers/${customerId}/preferred-groomer`,
      headers: { cookie: editorCookie }, payload: { employeeId }
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({
      method: "PATCH", url: `/api/customers/${customerId}/preferred-groomer`,
      headers: { cookie: ownerCookie }, payload: { employeeId }
    });
    expect(allowed.statusCode).toBe(200);
    const projection = await app.inject({
      method: "GET", url: `/api/customers/${customerId}/history`, headers: { cookie: historyCookie }
    });
    expect(projection.statusCode).toBe(200);
    expect(projection.json().customer.preferredEmployeeId).toBe(employeeId);
  });

  it("rejects retired permission inputs while retaining historical audit readability", async () => {
    const retiredInvitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email: `retired-${suffix}@example.test`, permissions: ["pets.safety.edit"] }
    });
    expect(retiredInvitation.statusCode).toBe(400);
    const retiredUpdate = await app.inject({
      method: "PATCH", url: `/api/members/${crypto.randomUUID()}/permissions`,
      headers: { cookie: ownerCookie }, payload: { permissions: ["pets.safety.view"] }
    });
    expect(retiredUpdate.statusCode).toBe(400);

    await db`
      insert into audit_events(
        business_id,actor_id,action,resource_type,resource_id,correlation_id
      ) values (
        ${businessId},null,'pet.safety.update','pet',${petId},${crypto.randomUUID()}
      )
    `;
    const audit = await app.inject({
      method: "GET", url: "/api/audit", headers: { cookie: ownerCookie }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().some((event: { action: string }) => event.action === "pet.safety.update"))
      .toBe(true);
  });

  it("rejects stale pet replacements atomically and records truthful safety audits", async () => {
    const list = await app.inject({
      method: "GET", url: `/api/pets?customerId=${customerId}`,
      headers: { cookie: careCookie }
    });
    const version = list.json()[0].version as number;
    const changed = await app.inject({
      method: "PUT", url: `/api/pets/${petId}/care`, headers: { cookie: careCookie },
      payload: { version, safetyAlerts: "Two-person handling" }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().version).toBe(version + 1);
    expect(await careAuditCount()).toBe(1);

    const unchanged = await app.inject({
      method: "PUT", url: `/api/pets/${petId}/care`, headers: { cookie: careCookie },
      payload: { version: version + 1, safetyAlerts: "Two-person handling" }
    });
    expect(unchanged.statusCode).toBe(200);
    expect(await careAuditCount()).toBe(1);

    const stale = await app.inject({
      method: "PUT", url: `/api/pets/${petId}`, headers: { cookie: careCookie },
      payload: profilePayload(changed.json(), { name: "Stale overwrite" })
    });
    expect(stale.statusCode).toBe(409);
    const [authoritative] = await db<{ name: string; safetyAlerts: string; version: number }[]>`
      select name,safety_alerts,version from pets where business_id=${businessId} and id=${petId}
    `;
    expect(authoritative).toMatchObject({
      name: "D3 Pet", safetyAlerts: "Two-person handling", version: version + 2
    });
    expect(await careAuditCount()).toBe(1);

    const [audit] = await db<{ afterData: { changedFields: string[] } }[]>`
      select after_data from audit_events
      where business_id=${businessId} and resource_id=${petId}
        and action='pet.care.update'
    `;
    expect(audit!.afterData).toEqual({ changedFields: ["safetyAlerts"] });
    expect(JSON.stringify(audit!.afterData)).not.toContain("Two-person handling");
  });

  it("preserves snapshot history, permission-projects finances, orders deterministically, and suppresses archived-parent pets", async () => {
    const appointment = await app.inject({
      method: "POST", url: "/api/appointments", headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId, serviceIds: [serviceId],
        localStart: "2035-04-10T10:00", expectedLocationVersion:1
      }
    });
    expect(appointment.statusCode).toBe(201);
    const appointmentId = appointment.json().id as string;
    await db`
      update services set name='Catalog Rename',base_duration_minutes=80,base_price_minor=9500
      where business_id=${businessId} and id=${serviceId}
    `;
    const [snapshot] = await db<{
      serviceNameSnapshot: string;
      durationMinutesSnapshot: number;
      priceMinorSnapshot: number;
    }[]>`
      select service_name_snapshot,duration_minutes_snapshot,price_minor_snapshot
      from appointment_services where business_id=${businessId} and appointment_id=${appointmentId}
    `;
    expect(snapshot).toEqual({
      serviceNameSnapshot: "Historic Groom", durationMinutesSnapshot: 50, priceMinorSnapshot: 7000
    });

    await db`
      insert into invoices(business_id,appointment_id,customer_id,status,subtotal_minor,total_minor,balance_minor)
      values (${businessId},${appointmentId},${customerId},'open',7000,7000,7000)
    `;
    const noPayments = await app.inject({
      method: "GET", url: `/api/customers/${customerId}/history`,
      headers: { cookie: historyCookie }
    });
    expect(noPayments.json().invoices).toEqual([]);
    const ownerHistory = await app.inject({
      method: "GET", url: `/api/customers/${customerId}/history`,
      headers: { cookie: ownerCookie }
    });
    expect(ownerHistory.json().invoices[0]).toMatchObject({ totalMinor: 7000, balanceMinor: 7000 });

    const archived = await app.inject({
      method: "POST", url: `/api/customers/${customerId}/archive`,
      headers: { cookie: ownerCookie }
    });
    expect(archived.statusCode).toBe(204);
    const activePets = await app.inject({
      method: "GET", url: "/api/pets", headers: { cookie: ownerCookie }
    });
    expect(activePets.json().some((pet: { id: string }) => pet.id === petId)).toBe(false);
    const [storedPet] = await db<{ archivedAt: string | null }[]>`
      select archived_at from pets where business_id=${businessId} and id=${petId}
    `;
    expect(storedPet!.archivedAt).toBeNull();
    const preservedHistory = await app.inject({
      method: "GET", url: `/api/customers/${customerId}/history`,
      headers: { cookie: ownerCookie }
    });
    expect(preservedHistory.statusCode).toBe(200);
    // The profile splits appointments into what is still ahead and what is settled, so the
    // preserved booking is looked for across both rather than in one undivided array.
    expect([...preservedHistory.json().upcoming.items, ...preservedHistory.json().history.items]
      .map((item: { id: string }) => item.id)).toContain(appointmentId);
  });

  it("records bounded D3 search and customer-scoped history diagnostics at the pilot envelope", async () => {
    const [owner] = await db<{ userId: string }[]>`
      select user_id from business_memberships
      where business_id=${businessId} and is_owner=true
    `;
    await db`
      insert into customers(
        business_id,first_name,last_name,normalized_email,preferred_contact_method,
        email_allowed,created_by,updated_by
      )
      select ${businessId},'Pilot',lpad(series::text,4,'0'),
        'pilot-' || series || '@example.test','none',false,${owner!.userId},${owner!.userId}
      from generate_series(1,2000) series
    `;
    await db`
      insert into pets(business_id,customer_id,name,species,created_by,updated_by)
      select c.business_id,c.id,'Pilot Pet ' || row_number() over (order by c.id,g.n),'dog',
        ${owner!.userId},${owner!.userId}
      from customers c cross join generate_series(1,3) g(n)
      where c.business_id=${businessId} and c.first_name='Pilot'
        and c.id in (
          select id from customers where business_id=${businessId} and first_name='Pilot'
          order by id limit 1000
        )
    `;
    const [frequentCustomer] = await db<{ id: string }[]>`
      select id from customers where business_id=${businessId} and first_name='Pilot'
      order by id limit 1
    `;
    const [frequentPet] = await db<{ id: string }[]>`
      select id from pets where business_id=${businessId} and customer_id=${frequentCustomer!.id}
      order by id limit 1
    `;
    await db`
      insert into appointments(
        business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,
        created_by,updated_by
      )
      select ${businessId},${locationId},${frequentCustomer!.id},${frequentPet!.id},${employeeId},
        timestamptz '2030-01-01 09:00:00+00' + series * interval '1 day',
        timestamptz '2030-01-01 10:00:00+00' + series * interval '1 day',
        'America/Los_Angeles',(timestamptz '2030-01-01 09:00:00+00' + series * interval '1 day') at time zone 'America/Los_Angeles',-480,
        (array['completed','cancelled','no_show']::appointment_status[])[1 + (series % 3)],
        ${owner!.userId},${owner!.userId}
      from generate_series(1,300) series
    `;

    const measure = async (url: string) => {
      const samples: number[] = [];
      let bytes = 0;
      let count = 0;
      for (let sample = 0; sample < 3; sample += 1) {
        const started = performance.now();
        const response = await app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
        samples.push(performance.now() - started);
        expect(response.statusCode).toBe(200);
        bytes = Buffer.byteLength(response.body);
        const value = response.json();
        count = Array.isArray(value) ? value.length : value.history.items.length;
      }
      samples.sort((a, b) => a - b);
      return { medianMs: Number(samples[1]!.toFixed(2)), bytes, count };
    };
    const evidence = {
      environment: "CI PostgreSQL diagnostic; warm API samples; browser startup excluded",
      seedVersion: "d3-v1",
      customers: 2000,
      pets: 3000,
      highFrequencyAppointments: 300,
      customerSearch: await measure("/api/customers?q=Pilot"),
      petSearch: await measure("/api/pets?q=Pilot"),
      highFrequencyHistory: await measure(`/api/customers/${frequentCustomer!.id}/history`)
    };
    console.info("D3_QUERY_DIAGNOSTICS", JSON.stringify(evidence));
    expect(evidence.customerSearch.count).toBe(100);
    expect(evidence.petSearch.count).toBe(100);
    // The client profile opens on a preview of settled history rather than the whole log; the
    // paginated history route serves the rest as the operator asks for it.
    expect(evidence.highFrequencyHistory.count).toBe(5);
    const profile = await app.inject({
      method: "GET", url: `/api/customers/${frequentCustomer!.id}/history`,
      headers: { cookie: ownerCookie }
    });
    expect(profile.json()).toMatchObject({ appointmentTotal: 300, appointmentsTruncated: true });
    const secondPage = await app.inject({
      method: "GET",
      url: `/api/customers/${frequentCustomer!.id}/appointments?page=2&pageSize=100`,
      headers: { cookie: ownerCookie }
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json()).toMatchObject({ total: 300, page: 2, pageSize: 100 });
    expect(secondPage.json().items).toHaveLength(100);
    const firstPageIds = new Set([
      ...profile.json().upcoming.items, ...profile.json().history.items
    ].map((item: { id: string }) => item.id));
    expect(secondPage.json().items.every((item: { id: string }) => !firstPageIds.has(item.id))).toBe(true);
  }, 30_000);
});
