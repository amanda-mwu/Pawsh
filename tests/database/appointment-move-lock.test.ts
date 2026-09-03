import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { formatWallTime } from "../../src/domain/time.js";
import { roleFor } from "../support/roles.js";

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

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
}

/**
 * Settings -> Business `appointment_lock` and the reschedule route.
 *
 * The rule under test is an AND: a move needs `appointments.edit` AND the lock disabled. These
 * suites pin both halves independently, because a regression in either one reads identically from
 * the calendar (the drag simply does not take) while meaning something completely different.
 */
describeDatabase("appointment move lock", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string;
  let editorCookie: string;
  let viewerCookie: string;
  let businessId: string;
  let locationId: string;
  let customerId: string;
  let petId: string;
  let serviceId: string;
  let otherServiceId: string;
  let employeeA: string;
  let employeeB: string;

  const suffix = crypto.randomUUID();
  const zone = "America/Los_Angeles";

  const create = (cookie: string, employeeId: string, startAt: string) =>
    app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId, serviceIds: [serviceId],
        localStart: formatWallTime(startAt, zone),
        expectedLocationVersion: 1
      }
    });

  const move = (
    cookie: string,
    appointmentId: string,
    payload: { employeeId: string; localStart: string; version: number }
  ) =>
    app.inject({
      method: "PATCH",
      url: `/api/appointments/${appointmentId}/schedule`,
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { ...payload, expectedLocationVersion: 1 }
    });

  async function setLock(mode: "enabled" | "disabled"): Promise<void> {
    await db`update businesses set appointment_lock=${mode} where id=${businessId}`;
  }

  async function stored(id: string): Promise<{ startAt: Date; employeeId: string; version: number }> {
    const [row] = await db<{ startAt: Date; employeeId: string; version: number }[]>`
      select start_at,employee_id,version from appointments where id=${id}
    `;
    return row!;
  }

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        email: `move-lock-owner-${suffix}@example.test`,
        password: "correct horse move lock battery",
        businessName: "Move Lock Grooming"
      }
    });
    expect(signup.statusCode).toBe(201);
    ownerCookie = sessionCookie(signup);
    ({ businessId, locationId } = signup.json());

    const makeService = async (name: string) => {
      const response = await app.inject({
        method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
        payload: { name, baseDurationMinutes: 60, basePriceMinor: 7000 }
      });
      expect(response.statusCode).toBe(201);
      return response.json().id as string;
    };
    serviceId = await makeService("Move Lock Groom");
    otherServiceId = await makeService("Move Lock Bath");

    const makeEmployee = async (displayName: string) => {
      const response = await app.inject({
        method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
        payload: { displayName, serviceIds: [serviceId, otherServiceId] }
      });
      expect(response.statusCode).toBe(201);
      return response.json().id as string;
    };
    employeeA = await makeEmployee("Move Lock Groomer A");
    employeeB = await makeEmployee("Move Lock Groomer B");

    const customer = await app.inject({
      method: "POST", url: "/api/customers",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { firstName: "Move", lastName: "Lock", preferredContactMethod: "none", emailAllowed: false }
    });
    customerId = customer.json().id;
    const pet = await app.inject({
      method: "POST", url: "/api/pets",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { customerId, name: "Move Lock Pet", species: "dog" }
    });
    petId = pet.json().id;

    // Two non-owner members, differing only in whether they hold `appointments.edit`. The editor
    // stands in for the receptionist preset that holds the move today; the viewer stands for the
    // groomer preset that does not.
    const seedMember = async (label: string, permissions: readonly string[]) => {
      const email = `move-lock-${label}-${suffix}@example.test`;
      const password = `correct horse move lock ${label}`;
      const [user] = await db<{ id: string }[]>`
        insert into users(email,normalized_email,password_hash)
        values (${email},${email},${await hashPassword(password)}) returning id
      `;
      await db`
        insert into business_memberships(business_id,user_id,role_id)
        values (${businessId},${user!.id},${await roleFor(db, businessId, permissions)})
      `;
      const login = await app.inject({
        method: "POST", url: "/api/auth/login", payload: { email, password }
      });
      expect(login.statusCode).toBe(200);
      return sessionCookie(login);
    };
    editorCookie = await seedMember("editor",
      ["calendar.view", "appointments.view", "appointments.create", "appointments.edit"]);
    viewerCookie = await seedMember("viewer",
      ["calendar.view", "appointments.view", "operations.check_in"]);
  });

  afterAll(async () => {
    await setLock("disabled");
    await app.close();
    await db.end();
  });

  it("allows a time change and a groomer change while the lock is disabled", async () => {
    await setLock("disabled");
    const created = await create(ownerCookie, employeeA, "2033-02-07T17:00:00.000Z");
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const timeChange = await move(editorCookie, id, {
      employeeId: employeeA,
      localStart: formatWallTime("2033-02-07T21:00:00.000Z", zone),
      version: created.json().version
    });
    expect(timeChange.statusCode).toBe(200);
    expect((await stored(id)).startAt.toISOString()).toBe("2033-02-07T21:00:00.000Z");

    const groomerChange = await move(editorCookie, id, {
      employeeId: employeeB,
      localStart: formatWallTime("2033-02-07T21:00:00.000Z", zone),
      version: (await stored(id)).version
    });
    expect(groomerChange.statusCode).toBe(200);
    expect((await stored(id)).employeeId).toBe(employeeB);
  });

  it("refuses a time change with a coded 409 while the lock is enabled", async () => {
    await setLock("disabled");
    const created = await create(ownerCookie, employeeA, "2033-02-08T17:00:00.000Z");
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await setLock("enabled");

    const refused = await move(editorCookie, id, {
      employeeId: employeeA,
      localStart: formatWallTime("2033-02-08T21:00:00.000Z", zone),
      version: created.json().version
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      code: "APPOINTMENT_MOVE_LOCKED",
      error: "Appointments are locked from being moved. A manager can unlock this in Settings → Business."
    });

    // A refused move writes nothing: not the time, not the version, not the idempotency claim.
    const after = await stored(id);
    expect(after.startAt.toISOString()).toBe("2033-02-08T17:00:00.000Z");
    expect(after.version).toBe(created.json().version);
  });

  it("refuses a groomer reassignment with the same coded 409", async () => {
    await setLock("disabled");
    const created = await create(ownerCookie, employeeA, "2033-02-09T17:00:00.000Z");
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await setLock("enabled");

    const refused = await move(editorCookie, id, {
      employeeId: employeeB,
      localStart: formatWallTime("2033-02-09T17:00:00.000Z", zone),
      version: created.json().version
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("APPOINTMENT_MOVE_LOCKED");

    expect((await stored(id)).employeeId).toBe(employeeA);
    const assignments = await db<{ employeeId: string }[]>`
      select employee_id from appointment_employees where appointment_id=${id}
    `;
    expect(assignments.map((row) => row.employeeId)).toEqual([employeeA]);
  });

  it("refuses an owner too - the lock is a policy switch, not a permission", async () => {
    await setLock("disabled");
    const created = await create(ownerCookie, employeeA, "2033-02-10T17:00:00.000Z");
    const id = created.json().id as string;
    await setLock("enabled");

    const refused = await move(ownerCookie, id, {
      employeeId: employeeA,
      localStart: formatWallTime("2033-02-10T21:00:00.000Z", zone),
      version: created.json().version
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("APPOINTMENT_MOVE_LOCKED");
    expect((await stored(id)).startAt.toISOString()).toBe("2033-02-10T17:00:00.000Z");
  });

  it("leaves content edits alone under the lock", async () => {
    await setLock("disabled");
    const created = await create(ownerCookie, employeeA, "2033-02-11T17:00:00.000Z");
    const id = created.json().id as string;
    await setLock("enabled");

    // Services, and therefore price and the derived end time, still change.
    const services = await app.inject({
      method: "PUT", url: `/api/appointments/${id}/services`,
      headers: { cookie: editorCookie },
      payload: { serviceIds: [serviceId, otherServiceId], version: created.json().version }
    });
    expect(services.statusCode).toBe(200);

    // So does status.
    const checkedIn = await app.inject({
      method: "POST", url: `/api/appointments/${id}/transition`,
      headers: { cookie: ownerCookie },
      payload: { status: "checked_in" }
    });
    expect(checkedIn.statusCode).toBe(200);

    // And operational notes.
    const notes = await app.inject({
      method: "PATCH", url: `/api/appointments/${id}/operations`,
      headers: { cookie: ownerCookie },
      payload: { operationalNotes: "Nervous about the dryer" }
    });
    expect(notes.statusCode).toBe(200);

    // None of that moved the appointment.
    expect((await stored(id)).startAt.toISOString()).toBe("2033-02-11T17:00:00.000Z");
    expect((await stored(id)).employeeId).toBe(employeeA);
  });

  it("does not refuse a reschedule request that changes neither the time nor the groomer", async () => {
    await setLock("disabled");
    const created = await create(ownerCookie, employeeA, "2033-02-12T17:00:00.000Z");
    const id = created.json().id as string;
    await setLock("enabled");

    // The gate is on what actually differs from what is stored, not on which endpoint was called.
    const noop = await move(editorCookie, id, {
      employeeId: employeeA,
      localStart: formatWallTime("2033-02-12T17:00:00.000Z", zone),
      version: created.json().version
    });
    expect(noop.statusCode).toBe(200);
  });

  it("still books new appointments under the lock", async () => {
    await setLock("enabled");
    const created = await create(editorCookie, employeeB, "2033-02-13T17:00:00.000Z");
    expect(created.statusCode).toBe(201);
  });

  it("keeps the permission gate unchanged when the lock is disabled", async () => {
    await setLock("disabled");
    const created = await create(ownerCookie, employeeA, "2033-02-14T17:00:00.000Z");
    const id = created.json().id as string;

    const refused = await move(viewerCookie, id, {
      employeeId: employeeA,
      localStart: formatWallTime("2033-02-14T21:00:00.000Z", zone),
      version: created.json().version
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).not.toBe("APPOINTMENT_MOVE_LOCKED");
    expect((await stored(id)).startAt.toISOString()).toBe("2033-02-14T17:00:00.000Z");
  });

  it("publishes the lock on /api/me and honours it from the settings form", async () => {
    await setLock("disabled");
    const created = await create(ownerCookie, employeeA, "2033-02-15T17:00:00.000Z");
    const id = created.json().id as string;

    const before = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } });
    expect(before.json().business.appointmentLock).toBe("disabled");

    const saved = await app.inject({
      method: "PUT", url: "/api/business/settings", headers: { cookie: ownerCookie },
      payload: {
        name: "Move Lock Grooming",
        timezone: zone,
        taxRateBasisPoints: 0,
        reminderLeadMinutes: 1440,
        locationVersion: before.json().business.locationVersion,
        appointmentLock: "enabled"
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().appointmentLock).toBe("enabled");

    const after = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } });
    expect(after.json().business.appointmentLock).toBe("enabled");

    const refused = await app.inject({
      method: "PATCH", url: `/api/appointments/${id}/schedule`,
      headers: { cookie: editorCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        employeeId: employeeA,
        localStart: formatWallTime("2033-02-15T21:00:00.000Z", zone),
        version: created.json().version,
        expectedLocationVersion: after.json().business.locationVersion
      }
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("APPOINTMENT_MOVE_LOCKED");
  });
});
