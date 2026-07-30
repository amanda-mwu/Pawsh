import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";

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

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
}

describeDatabase("D1 scheduling regression", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let barrier: { expected: number; arrived: number; release: () => void; promise: Promise<void> } | null = null;
  let failAfterOverrideAudit = false;
  let ownerCookie: string;
  let businessId: string;
  let locationId: string;
  let customerId: string;
  let petId: string;
  let serviceId: string;
  let employeeA: string;
  let employeeB: string;
  let memberCookie: string;
  let memberId: string;

  const suffix = crypto.randomUUID();
  const schedulePayload = (employeeId: string, startAt: string) => ({
    locationId,
    customerId,
    petId,
    employeeId,
    serviceIds: [serviceId],
    startAt
  });
  const create = (cookie: string, employeeId: string, startAt: string, extra: object = {}) =>
    app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie },
      payload: { ...schedulePayload(employeeId, startAt), ...extra }
    });

  function armBarrier(expected = 2): void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => { release = resolve; });
    barrier = { expected, arrived: 0, release, promise };
  }

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, {
      runWorker: false,
      serveStatic: false,
      schedulingHooks: {
        async beforeLock({ operation }) {
          if (operation !== "create" || !barrier) return;
          const active = barrier;
          active.arrived += 1;
          if (active.arrived === active.expected) {
            barrier = null;
            active.release();
          }
          await active.promise;
        },
        async afterOverrideAudit() {
          if (!failAfterOverrideAudit) return;
          failAfterOverrideAudit = false;
          throw new Error("Controlled post-audit transaction failure");
        }
      }
    });
    await app.ready();

    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        email: `schedule-owner-${suffix}@example.test`,
        password: "correct horse schedule battery",
        businessName: "D1 Scheduling"
      }
    });
    expect(signup.statusCode).toBe(201);
    ownerCookie = sessionCookie(signup);
    ({ businessId, locationId } = signup.json());

    const service = await app.inject({
      method: "POST",
      url: "/api/services",
      headers: { cookie: ownerCookie },
      payload: { name: "D1 Groom", baseDurationMinutes: 60, basePriceMinor: 7000 }
    });
    serviceId = service.json().id;
    const createEmployee = async (displayName: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/employees",
        headers: { cookie: ownerCookie },
        payload: { displayName, serviceIds: [serviceId] }
      });
      expect(response.statusCode).toBe(201);
      return response.json().id as string;
    };
    employeeA = await createEmployee("D1 Groomer A");
    employeeB = await createEmployee("D1 Groomer B");

    const customer = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { cookie: ownerCookie },
      payload: {
        firstName: "D1",
        lastName: "Customer",
        preferredContactMethod: "none",
        emailAllowed: false
      }
    });
    customerId = customer.json().id;
    const pet = await app.inject({
      method: "POST",
      url: "/api/pets",
      headers: { cookie: ownerCookie },
      payload: { customerId, name: "D1 Pet", species: "dog" }
    });
    petId = pet.json().id;

    const memberEmail = `schedule-member-${suffix}@example.test`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash)
      values (${memberEmail},${memberEmail},${await hashPassword("correct horse schedule member")})
      returning id
    `;
    const [membership] = await db<{ id: string }[]>`
      insert into business_memberships(business_id,user_id,permissions)
      values (${businessId},${user!.id},${["calendar.view","appointments.view","appointments.create","appointments.edit"]})
      returning id
    `;
    memberId = membership!.id;
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: memberEmail, password: "correct horse schedule member" }
    });
    memberCookie = sessionCookie(login);
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("serializes simultaneous normal bookings while allowing different employees", async () => {
    const startAt = "2032-01-05T17:00:00.000Z";
    armBarrier();
    const results = await Promise.all([
      create(ownerCookie, employeeA, startAt),
      create(ownerCookie, employeeA, startAt)
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.statusCode === 409)?.json()).toMatchObject({
      code: "SCHEDULING_CONFLICT",
      canOverride: true
    });
    const [count] = await db<{ count: number }[]>`
      select count(*)::integer as count
      from appointments
      where business_id=${businessId} and employee_id=${employeeA}
        and start_at=${startAt}
    `;
    expect(count?.count).toBe(1);

    const otherEmployee = await create(ownerCookie, employeeB, startAt);
    expect(otherEmployee.statusCode).toBe(201);
  });

  it("applies only explicit authorized conflicts and records one atomic override audit", async () => {
    const startAt = "2032-01-06T17:00:00.000Z";
    const existing = await create(ownerCookie, employeeA, startAt);
    expect(existing.statusCode).toBe(201);
    const conflict = await create(ownerCookie, employeeA, startAt);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().conflicts).toHaveLength(1);

    const overridden = await create(ownerCookie, employeeA, startAt, { overrideConflict: true });
    expect(overridden.statusCode).toBe(201);
    expect(overridden.json().scheduling).toEqual({
      conflictDetected: true,
      overrideRequested: true,
      overrideAuthorized: true,
      overrideApplied: true
    });
    const [appointments, audits] = await Promise.all([
      db<{ count: number }[]>`
        select count(*)::integer as count from appointments
        where business_id=${businessId} and employee_id=${employeeA} and start_at=${startAt}
      `,
      db<{ count: number }[]>`
        select count(*)::integer as count from audit_events
        where business_id=${businessId}
          and resource_id=${overridden.json().id}
          and action='appointment.conflict_override'
      `
    ]);
    expect(appointments[0]?.count).toBe(2);
    expect(audits[0]?.count).toBe(1);

    const noConflict = await create(ownerCookie, employeeB, "2032-01-06T20:00:00.000Z", {
      overrideConflict: true
    });
    expect(noConflict.statusCode).toBe(201);
    expect(noConflict.json().scheduling.overrideApplied).toBe(false);
    const [falseAudit] = await db<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where resource_id=${noConflict.json().id} and action='appointment.conflict_override'
    `;
    expect(falseAudit?.count).toBe(0);
  });

  it("rolls back both mutation and override audit when the transaction fails", async () => {
    const startAt = "2032-01-12T17:00:00.000Z";
    expect((await create(ownerCookie, employeeA, startAt)).statusCode).toBe(201);
    failAfterOverrideAudit = true;
    const failed = await create(ownerCookie, employeeA, startAt, { overrideConflict: true });
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toEqual({ error: "Controlled post-audit transaction failure" });
    const [appointments, audits] = await Promise.all([
      db<{ count: number }[]>`
        select count(*)::integer as count from appointments
        where business_id=${businessId} and employee_id=${employeeA} and start_at=${startAt}
      `,
      db<{ count: number }[]>`
        select count(*)::integer as count from audit_events
        where business_id=${businessId} and action='appointment.conflict_override'
          and after_data->>'startAt'=${startAt}
      `
    ]);
    expect(appointments[0]?.count).toBe(1);
    expect(audits[0]?.count).toBe(0);
  });

  it("denies unauthorized, stale, and base-permission-free override intent", async () => {
    const startAt = "2032-01-07T17:00:00.000Z";
    expect((await create(ownerCookie, employeeA, startAt)).statusCode).toBe(201);
    const unauthorized = await create(memberCookie, employeeA, startAt, { overrideConflict: true });
    expect(unauthorized.statusCode).toBe(403);
    const clientClaims = await create(memberCookie, employeeA, startAt, {
      manager: true,
      canOverride: true,
      role: "owner"
    });
    expect(clientClaims.statusCode).toBe(409);

    await db`
      update business_memberships
      set permissions=${["appointments.override_conflict"]}
      where id=${memberId}
    `;
    const lacksBasePermission = await create(memberCookie, employeeA, startAt, { overrideConflict: true });
    expect(lacksBasePermission.statusCode).toBe(403);

    await db`
      update business_memberships
      set permissions=${["appointments.create","appointments.override_conflict"]}
      where id=${memberId}
    `;
    const loaded = await create(memberCookie, employeeA, startAt);
    expect(loaded.statusCode).toBe(409);
    expect(loaded.json().canOverride).toBe(true);
    await db`
      update business_memberships
      set permissions=${["appointments.create"]}
      where id=${memberId}
    `;
    const stale = await create(memberCookie, employeeA, startAt, { overrideConflict: true });
    expect(stale.statusCode).toBe(403);

    const [audit] = await db<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where business_id=${businessId} and action='appointment.conflict_override'
        and actor_id=(select user_id from business_memberships where id=${memberId})
    `;
    expect(audit?.count).toBe(0);
  });

  it("keeps mixed normal and override races valid for either serialization order", async () => {
    const startAt = "2032-01-10T17:00:00.000Z";
    armBarrier();
    const [normal, override] = await Promise.all([
      create(ownerCookie, employeeA, startAt),
      create(ownerCookie, employeeA, startAt, { overrideConflict: true })
    ]);
    expect([normal.statusCode, override.statusCode].every((status) => [201,409].includes(status))).toBe(true);
    const [appointments, audits] = await Promise.all([
      db<{ count: number }[]>`
        select count(*)::integer as count from appointments
        where business_id=${businessId} and employee_id=${employeeA} and start_at=${startAt}
      `,
      db<{ count: number }[]>`
        select count(*)::integer as count from audit_events
        where business_id=${businessId} and action='appointment.conflict_override'
          and resource_id in (
            select id from appointments
            where business_id=${businessId} and employee_id=${employeeA} and start_at=${startAt}
          )
      `
    ]);
    expect([1,2]).toContain(appointments[0]?.count);
    expect(audits[0]?.count).toBe(appointments[0]?.count === 2 ? 1 : 0);
    if (appointments[0]?.count === 2) {
      expect(normal.statusCode).toBe(201);
      expect(override.statusCode).toBe(201);
      expect(override.json().scheduling.overrideApplied).toBe(true);
    } else {
      expect(normal.statusCode).toBe(409);
      expect(override.statusCode).toBe(201);
      expect(override.json().scheduling.overrideApplied).toBe(false);
    }
  });

  it("does not let override intent cross the tenant boundary", async () => {
    const foreignSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        email: `foreign-owner-${suffix}@example.test`,
        password: "correct horse foreign schedule",
        businessName: "Foreign D1"
      }
    });
    const foreignCookie = sessionCookie(foreignSignup);
    const response = await create(
      foreignCookie,
      employeeA,
      "2032-01-11T17:00:00.000Z",
      { overrideConflict: true }
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "The selected customer or pet is unavailable" });
    const [count] = await db<{ count: number }[]>`
      select count(*)::integer as count
      from appointments
      where employee_id=${employeeA} and start_at='2032-01-11T17:00:00.000Z'
    `;
    expect(count?.count).toBe(0);
  });

  it("preserves the original schedule when a conflicting move fails and permits an authorized move", async () => {
    const existingStart = "2032-01-08T17:00:00.000Z";
    const movableStart = "2032-01-08T20:00:00.000Z";
    const existing = await create(ownerCookie, employeeA, existingStart);
    const movable = await create(ownerCookie, employeeA, movableStart);
    expect(existing.statusCode).toBe(201);
    expect(movable.statusCode).toBe(201);

    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/appointments/${movable.json().id}/schedule`,
      headers: { cookie: ownerCookie },
      payload: { employeeId: employeeA, startAt: existingStart, version: movable.json().version }
    });
    expect(rejected.statusCode).toBe(409);
    const [unchanged] = await db<{ startAt: Date }[]>`
      select start_at from appointments where id=${movable.json().id}
    `;
    expect(unchanged?.startAt.toISOString()).toBe(movableStart);

    const moved = await app.inject({
      method: "PATCH",
      url: `/api/appointments/${movable.json().id}/schedule`,
      headers: { cookie: ownerCookie },
      payload: {
        employeeId: employeeA,
        startAt: existingStart,
        version: movable.json().version,
        overrideConflict: true
      }
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().scheduling.overrideApplied).toBe(true);
  });

  it("orders cross-employee reschedule locks without deadlock", async () => {
    const first = await create(ownerCookie, employeeA, "2032-01-13T17:00:00.000Z");
    const second = await create(ownerCookie, employeeB, "2032-01-13T20:00:00.000Z");
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const results = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/appointments/${first.json().id}/schedule`,
        headers: { cookie: ownerCookie },
        payload: {
          employeeId: employeeB,
          startAt: "2032-01-13T17:00:00.000Z",
          version: first.json().version
        }
      }),
      app.inject({
        method: "PATCH",
        url: `/api/appointments/${second.json().id}/schedule`,
        headers: { cookie: ownerCookie },
        payload: {
          employeeId: employeeA,
          startAt: "2032-01-13T20:00:00.000Z",
          version: second.json().version
        }
      })
    ]);
    expect(results.map((result) => result.statusCode)).toEqual([200,200]);
  });

  it("makes cancellation nonblocking and keeps the transition auditable", async () => {
    const startAt = "2032-01-09T17:00:00.000Z";
    const appointment = await create(ownerCookie, employeeA, startAt);
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/appointments/${appointment.json().id}/transition`,
      headers: { cookie: ownerCookie },
      payload: { status: "cancelled", version: appointment.json().version }
    });
    expect(cancelled.statusCode).toBe(200);
    expect((await create(ownerCookie, employeeA, startAt)).statusCode).toBe(201);
    const [audit] = await db<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where resource_id=${appointment.json().id} and action='appointment.cancelled'
    `;
    expect(audit?.count).toBe(1);
  });

  it("enforces implemented employee-hour and blocked-time availability boundaries", async () => {
    const hours = await app.inject({
      method: "PUT",
      url: `/api/employees/${employeeA}/working-hours`,
      headers: { cookie: ownerCookie },
      payload: {
        hours: [0,1,2,3,4,5,6].map((weekday) => ({
          weekday,
          startTime: "09:00",
          endTime: "17:00"
        }))
      }
    });
    expect(hours.statusCode).toBe(204);
    expect((await create(ownerCookie, employeeA, "2032-01-14T16:59:00.000Z")).statusCode).toBe(400);
    expect((await create(ownerCookie, employeeA, "2032-01-14T17:00:00.000Z")).statusCode).toBe(201);
    expect((await create(ownerCookie, employeeA, "2032-01-15T00:00:00.000Z")).statusCode).toBe(201);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/blocked-times",
      headers: { cookie: ownerCookie },
      payload: {
        employeeId: employeeA,
        startAt: "2032-01-15T20:00:00.000Z",
        endAt: "2032-01-15T21:00:00.000Z",
        reason: "D1 blocked interval"
      }
    });
    expect(blocked.statusCode).toBe(201);
    expect((await create(ownerCookie, employeeA, "2032-01-15T20:00:00.000Z")).statusCode).toBe(400);
    const overridden = await create(ownerCookie, employeeA, "2032-01-15T20:00:00.000Z", {
      availabilityOverride: true,
      overrideReason: "Owner-approved blocked-time exception"
    });
    expect(overridden.statusCode).toBe(201);
  });

  it("keeps the seven-day calendar bounded and deterministically ordered at the pilot envelope", async () => {
    const [owner] = await db<{ id: string }[]>`
      select user_id as id from business_memberships
      where business_id=${businessId} and is_owner
    `;
    await db`
      insert into appointments
        (business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,status,created_by,updated_by)
      select
        ${businessId},${locationId},${customerId},${petId},
        case when series.value % 2=0 then ${employeeA}::uuid else ${employeeB}::uuid end,
        '2032-02-02T17:00:00.000Z'::timestamptz
          + floor(series.value/2) * interval '15 minutes',
        '2032-02-02T17:00:00.000Z'::timestamptz
          + floor(series.value/2) * interval '15 minutes' + interval '60 minutes',
        'completed',${owner!.id},${owner!.id}
      from generate_series(0,524) as series(value)
    `;
    await db`
      insert into appointments
        (business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,status,created_by,updated_by)
      values (
        ${businessId},${locationId},${customerId},${petId},${employeeA},
        '2032-03-01T17:00:00.000Z','2032-03-01T18:00:00.000Z','completed',
        ${owner!.id},${owner!.id}
      )
    `;

    const startedAt = performance.now();
    const response = await app.inject({
      method: "GET",
      url: "/api/appointments?from=2032-02-02T17:00:00.000Z&to=2032-02-09T17:00:00.000Z",
      headers: { cookie: ownerCookie }
    });
    const elapsedMilliseconds = performance.now() - startedAt;
    expect(response.statusCode).toBe(200);
    const rows = response.json<Array<{ id: string; startAt: string; employeeId: string }>>();
    expect(rows).toHaveLength(525);
    const tuples = rows.map((row) => `${row.startAt}|${row.employeeId}|${row.id}`);
    expect(tuples).toEqual([...tuples].sort());

    const explain = await db<{ "QUERY PLAN": unknown }[]>`
      explain (analyze,buffers,format json)
      select id,start_at,end_at
      from appointments
      where business_id=${businessId}
        and start_at>='2032-02-02T17:00:00.000Z'
        and start_at<'2032-02-09T17:00:00.000Z'
      order by start_at,employee_id,id
    `;
    console.info("D1_CALENDAR_DIAGNOSTIC", JSON.stringify({
      datasetVersion: "d1-pilot-v1",
      returnedAppointments: rows.length,
      responseBytes: Buffer.byteLength(response.body),
      elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(2)),
      explain: explain[0]?.["QUERY PLAN"]
    }));
  });
});
