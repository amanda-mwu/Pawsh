import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissionPresets } from "@pawsh/domain";
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

describeDatabase("D1 scheduling regression", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let barrier: { expected: number; arrived: number; release: () => void; promise: Promise<void> } | null = null;
  let failAfterOverrideAudit = false;
  let failAfterCommit: "create"|"reschedule"|null=null;
  let locationLockGate: { reached:()=>void; wait:Promise<void> } | null=null;
  let claimRollbackGate:{reached:()=>void;wait:Promise<void>}|null=null;
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
    localStart:formatWallTime(startAt,"America/Los_Angeles"),expectedLocationVersion:1
  });
  const create = (cookie: string, employeeId: string, startAt: string, extra: object = {}) =>
    app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
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
          if(operation==="create"&&claimRollbackGate){
            const active=claimRollbackGate;claimRollbackGate=null;active.reached();await active.wait;
            throw new Error("Controlled winner rollback");
          }
          if (operation !== "create" || !barrier) return;
          const active = barrier;
          active.arrived += 1;
          if (active.arrived === active.expected) {
            barrier = null;
            active.release();
          }
          await active.promise;
        },
        async afterLocationLock({operation}) {
          if(operation!=="create"||!locationLockGate)return;
          const active=locationLockGate;locationLockGate=null;active.reached();await active.wait;
        },
        async afterOverrideAudit() {
          if (!failAfterOverrideAudit) return;
          failAfterOverrideAudit = false;
          throw new Error("Controlled post-audit transaction failure");
        },
        async afterCommit({operation}) {
          if(failAfterCommit!==operation)return;
          failAfterCommit=null;
          throw new Error("Controlled post-commit response failure");
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
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
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
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
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
      insert into business_memberships(business_id,user_id,role_id)
      values (${businessId},${user!.id},${await roleFor(db, businessId, ["calendar.view","appointments.view","appointments.create","appointments.edit","appointments.edit_all_staff"])})
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
    // THE MEMBER, NOT THE OWNER, RACES HERE. The owner holds `appointments.override_conflict`,
    // and a holder is let through an overlap without the 409 round trip, so two owner bookings
    // for one slot would both land. The member holds `appointments.create` and not the key, and
    // is the caller the refusal is written for - `canOverride: false`, because anybody the field
    // could say true for is never refused in the first place.
    armBarrier();
    const results = await Promise.all([
      create(memberCookie, employeeA, startAt),
      create(memberCookie, employeeA, startAt)
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.statusCode === 409)?.json()).toMatchObject({
      code: "SCHEDULING_CONFLICT",
      canOverride: false
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

  it("lets a holder of the override key through an overlap, asked or not, and records each one", async () => {
    const startAt = "2032-01-06T17:00:00.000Z";
    const existing = await create(ownerCookie, employeeA, startAt);
    expect(existing.statusCode).toBe(201);

    // WITHOUT THE FLAG. The owner holds `appointments.override_conflict`, so the overlap is
    // not a question to send back: the booking lands, the row says `conflict_overridden`, and
    // the override audit names the appointment it was laid over - the same trail an explicit
    // override has always left. `overrideRequested` is what the body said; the other three are
    // what the server decided.
    const implicit = await create(ownerCookie, employeeA, startAt);
    expect(implicit.statusCode, implicit.body).toBe(201);
    expect(implicit.json().scheduling).toEqual({
      conflictDetected: true,
      overrideRequested: false,
      overrideAuthorized: true,
      overrideApplied: true
    });
    expect(implicit.json().conflictOverridden).toBe(true);

    // WITH THE FLAG, which is still accepted and now redundant for this caller.
    const overridden = await create(ownerCookie, employeeA, startAt, { overrideConflict: true });
    expect(overridden.statusCode).toBe(201);
    expect(overridden.json().scheduling).toEqual({
      conflictDetected: true,
      overrideRequested: true,
      overrideAuthorized: true,
      overrideApplied: true
    });
    const overrideAudit = (id: string) => db<{ count: number; overlapped: unknown[] }[]>`
      select count(*)::integer as count,
        coalesce(jsonb_agg(after_data->'conflictingAppointmentIds'), '[]'::jsonb) as overlapped
      from audit_events
      where business_id=${businessId} and resource_id=${id} and action='appointment.conflict_override'
    `;
    const [appointments, [implicitAudit], [explicitAudit], [stored]] = await Promise.all([
      db<{ count: number }[]>`
        select count(*)::integer as count from appointments
        where business_id=${businessId} and employee_id=${employeeA} and start_at=${startAt}
      `,
      overrideAudit(implicit.json().id),
      overrideAudit(overridden.json().id),
      db<{ conflictOverridden: boolean }[]>`
        select conflict_overridden from appointments where id=${implicit.json().id}
      `
    ]);
    expect(appointments[0]?.count).toBe(3);
    expect(implicitAudit!.count).toBe(1);
    expect(JSON.stringify(implicitAudit!.overlapped)).toContain(existing.json().id);
    expect(explicitAudit!.count).toBe(1);
    expect(stored!.conflictOverridden).toBe(true);

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
    expect(clientClaims.json()).toMatchObject({ code: "SCHEDULING_CONFLICT", canOverride: false });

    await db`
      update business_memberships
      set role_id=${await roleFor(db, businessId, ["appointments.override_conflict"])}
      where id=${memberId}
    `;
    const lacksBasePermission = await create(memberCookie, employeeA, startAt, { overrideConflict: true });
    expect(lacksBasePermission.statusCode).toBe(403);

    // `appointments.edit_all_staff` rides along from here on because `appointments.create` is
    // scoped to the caller's own calendar and this member has no employee record: the roles
    // below are about the override key, and without the all-staff key the create route would
    // answer `NOT_ASSIGNED_TO_YOU` before the override key is consulted at all.
    await db`
      update business_memberships
      set role_id=${await roleFor(db, businessId, ["appointments.create","appointments.edit_all_staff","appointments.override_conflict"])}
      where id=${memberId}
    `;
    // Holding the key IS the override: the member is not refused and asked to say so, the
    // booking lands and the override is recorded against them - the one audit row the count at
    // the end of this case expects.
    const loaded = await create(memberCookie, employeeA, startAt);
    expect(loaded.statusCode, loaded.body).toBe(201);
    expect(loaded.json().scheduling).toEqual({
      conflictDetected: true, overrideRequested: false, overrideAuthorized: true, overrideApplied: true
    });
    await db`
      update business_memberships
      set role_id=${await roleFor(db, businessId, ["appointments.create","appointments.edit_all_staff"])}
      where id=${memberId}
    `;
    const stale = await create(memberCookie, employeeA, startAt, { overrideConflict: true });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error).toContain("appointments.override_conflict");

    // Exactly one override on the member's record: the booking they made while holding the key.
    // None of the three refusals above left one.
    const [audit] = await db<{ count: number; resourceIds: string[] }[]>`
      select count(*)::integer as count, coalesce(array_agg(resource_id), '{}') as resource_ids
      from audit_events
      where business_id=${businessId} and action='appointment.conflict_override'
        and actor_id=(select user_id from business_memberships where id=${memberId})
    `;
    expect(audit?.count).toBe(1);
    expect(audit?.resourceIds).toEqual([loaded.json().id]);
  });

  it("keeps mixed normal and override races valid for either serialization order", async () => {
    const startAt = "2032-01-10T17:00:00.000Z";
    // The "normal" booking is the member's, who holds no override key; the owner's is the one
    // that may be laid over it. Whichever wins the lock, the outcome has to be one of the two
    // consistent states below and never a third.
    armBarrier();
    const [normal, override] = await Promise.all([
      create(memberCookie, employeeA, startAt),
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

    // The member holds `appointments.edit` and `appointments.edit_all_staff` - enough to move
    // anybody's booking - and not the override key, so the move onto the other booking is refused
    // and the row does not move. Stated here rather than inherited, because an earlier case in
    // this file re-roles the member on its way through.
    await db`
      update business_memberships
      set role_id=${await roleFor(db, businessId, ["calendar.view","appointments.view","appointments.edit","appointments.edit_all_staff"])}
      where id=${memberId}
    `;
    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/appointments/${movable.json().id}/schedule`,
      headers: { cookie: memberCookie, "idempotency-key": crypto.randomUUID() },
      payload: { employeeId: employeeA, localStart:formatWallTime(existingStart,"America/Los_Angeles"),expectedLocationVersion:1, version: movable.json().version }
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(rejected.json()).toMatchObject({ code: "SCHEDULING_CONFLICT", canOverride: false });
    const [unchanged] = await db<{ startAt: Date }[]>`
      select start_at from appointments where id=${movable.json().id}
    `;
    expect(unchanged?.startAt.toISOString()).toBe(movableStart);

    // The owner asks for nothing and is let through: the same move, the same minutes, the
    // override applied and recorded because the caller holds the key.
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/appointments/${movable.json().id}/schedule`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        employeeId: employeeA,
        localStart:formatWallTime(existingStart,"America/Los_Angeles"),expectedLocationVersion:1,
        version: movable.json().version
      }
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().scheduling).toEqual({
      conflictDetected: true, overrideRequested: false, overrideAuthorized: true, overrideApplied: true
    });
    const [moveAudit] = await db<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where business_id=${businessId} and resource_id=${movable.json().id}
        and action='appointment.conflict_override' and after_data->>'operation'='reschedule'
    `;
    expect(moveAudit?.count).toBe(1);
  });

  /**
   * THE GROOMER PRESET OVERLAPS ITS OWN DAY, AND ONLY ITS OWN.
   *
   * The owner's rule: a groomer may lay one of their own visits over another of their own. The
   * preset holds `appointments.override_conflict`, so the move lands on the first request and is
   * recorded exactly as the desk's is. The key says nothing about whose calendar: the same move
   * onto a colleague, or of a colleague's visit, is the scope refusal before the overlap is ever
   * judged, and leaves no override on record.
   */
  it("lets the Groomer preset move one of its own visits over another, and refuses it a colleague's", async () => {
    const groomerEmail = `schedule-groomer-${suffix}@example.test`;
    const [groomerUser] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash)
      values (${groomerEmail},${groomerEmail},${await hashPassword("correct horse schedule groomer")})
      returning id
    `;
    const [groomerMembership] = await db<{ id: string }[]>`
      insert into business_memberships(business_id,user_id,role_id)
      values (${businessId},${groomerUser!.id},${await roleFor(db, businessId, permissionPresets.groomer!)})
      returning id
    `;
    const linked = await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: "D1 Groomer Linked", serviceIds: [serviceId], membershipId: groomerMembership!.id }
    });
    expect(linked.statusCode, linked.body).toBe(201);
    const employeeMine = linked.json().id as string;
    const groomerCookie = sessionCookie(await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { email: groomerEmail, password: "correct horse schedule groomer" }
    }));

    const firstStart = "2032-01-14T17:00:00.000Z";
    const first = await create(ownerCookie, employeeMine, firstStart);
    const second = await create(ownerCookie, employeeMine, "2032-01-14T20:00:00.000Z");
    const colleague = await create(ownerCookie, employeeA, "2032-01-14T17:00:00.000Z");
    expect([first.statusCode, second.statusCode, colleague.statusCode]).toEqual([201, 201, 201]);
    const reschedule = (id: string, cookie: string, employeeId: string, startAt: string, version: number) =>
      app.inject({
        method: "PATCH", url: `/api/appointments/${id}/schedule`,
        headers: { cookie, "idempotency-key": crypto.randomUUID() },
        payload: { employeeId, localStart: formatWallTime(startAt, "America/Los_Angeles"), expectedLocationVersion: 1, version }
      });

    // Their own second visit over their own first: lands, marked, recorded against the reschedule.
    const moved = await reschedule(second.json().id, groomerCookie, employeeMine, firstStart, second.json().version);
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().scheduling).toEqual({
      conflictDetected: true, overrideRequested: false, overrideAuthorized: true, overrideApplied: true
    });
    const [ownAudit] = await db<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where business_id=${businessId} and resource_id=${second.json().id}
        and action='appointment.conflict_override' and after_data->>'operation'='reschedule'
        and after_data->'conflictingAppointmentIds' ? ${first.json().id}
    `;
    expect(ownAudit?.count).toBe(1);

    // Onto a colleague's calendar, or of a colleague's visit: refused by scope, nothing recorded.
    const ontoColleague = await reschedule(first.json().id, groomerCookie, employeeA, firstStart, first.json().version);
    expect(ontoColleague.statusCode, ontoColleague.body).toBe(403);
    expect(ontoColleague.json().code).toBe("NOT_ASSIGNED_TO_YOU");
    const colleagues = await reschedule(colleague.json().id, groomerCookie, employeeMine, firstStart, colleague.json().version);
    expect(colleagues.statusCode, colleagues.body).toBe(403);
    expect(colleagues.json().code).toBe("NOT_ASSIGNED_TO_YOU");
    const [untouched] = await db<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where business_id=${businessId} and action='appointment.conflict_override'
        and resource_id in (${first.json().id}, ${colleague.json().id})
    `;
    expect(untouched?.count).toBe(0);
    const [rows] = await db<{ mine: string; theirs: string }[]>`
      select
        (select employee_id from appointments where id=${first.json().id}) as mine,
        (select employee_id from appointments where id=${colleague.json().id}) as theirs
    `;
    expect(rows).toEqual({ mine: employeeMine, theirs: employeeA });
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
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: {
          employeeId: employeeB,
          localStart: "2032-01-13T09:00",expectedLocationVersion:1,
          version: first.json().version
        }
      }),
      app.inject({
        method: "PATCH",
        url: `/api/appointments/${second.json().id}/schedule`,
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: {
          employeeId: employeeA,
          localStart: "2032-01-13T12:00",expectedLocationVersion:1,
          version: second.json().version
        }
      })
    ]);
    expect(results.map((result) => result.statusCode)).toEqual([200,200]);
  });

  /**
   * BOTH SIDES OF AN INTENTIONAL OVERLAP CAN BE WORKED.
   *
   * The two conflict triggers (0002 and 0015) fire on `update of ... status` and re-run the
   * overlap check whenever the new status occupies time, without reading `conflict_overridden`.
   * Until `/transition` set the override GUC for the row it was moving, checking in EITHER side of
   * a deliberately double-booked pair tripped the trigger and came back as a 409
   * `SCHEDULING_CONFLICT` with `canOverride: false` - to a front desk that was not scheduling
   * anything. A lifecycle move changes no geometry, so nothing it does can create an overlap the
   * booking path did not already judge; the route now says so to the trigger.
   */
  it("checks in and starts both sides of an intentional overlap, and leaves a plain visit's lifecycle alone", async () => {
    const startAt = "2032-01-20T18:00:00.000Z";
    const first = await create(ownerCookie, employeeA, startAt);
    expect(first.statusCode, first.body).toBe(201);
    const second = await create(ownerCookie, employeeA, startAt, { overrideConflict: true });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().scheduling.overrideApplied).toBe(true);
    const transition = (id: string, status: string) => app.inject({
      method: "POST", url: `/api/appointments/${id}/transition`,
      headers: { cookie: ownerCookie }, payload: { status }
    });
    const status = async (id: string) => {
      const [row] = await db<{ status: string }[]>`select status from appointments where id=${id}`;
      return row!.status;
    };
    for (const id of [first.json().id, second.json().id]) {
      const checkedIn = await transition(id, "checked_in");
      expect(checkedIn.statusCode, checkedIn.body).toBe(200);
      expect(checkedIn.json().status).toBe("checked_in");
      expect(await status(id)).toBe("checked_in");
    }
    for (const id of [first.json().id, second.json().id]) {
      const started = await transition(id, "in_service");
      expect(started.statusCode, started.body).toBe(200);
      expect(await status(id)).toBe("in_service");
    }
    // The overlap itself is untouched by working it: both rows still occupy the same hour, one
    // marked as the override it was.
    const [rows] = await db<{ count: number; overridden: number }[]>`
      select count(*)::integer as count, count(*) filter (where conflict_overridden)::integer as overridden
      from appointments where business_id=${businessId} and employee_id=${employeeA}
        and start_at=${startAt} and status='in_service'
    `;
    expect(rows).toEqual({ count: 2, overridden: 1 });

    // A visit nobody overlapped goes through every state exactly as before, with the audit trail
    // it always left.
    const plain = await create(ownerCookie, employeeB, startAt);
    expect(plain.statusCode, plain.body).toBe(201);
    for (const step of ["checked_in", "in_service", "completed"]) {
      const moved = await transition(plain.json().id, step);
      expect(moved.statusCode, `${step}: ${moved.body}`).toBe(200);
      expect(await status(plain.json().id)).toBe(step);
    }
    const [audits] = await db<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where business_id=${businessId} and resource_id=${plain.json().id}
        and action in ('appointment.checked_in','appointment.in_service','appointment.completed')
    `;
    expect(audits?.count).toBe(3);
  });

  /**
   * THE FIVE-MINUTE GRID. Every scheduled wall-clock time - a booking's start, a move's start, a
   * block's two ends - is refused off a five-minute mark, with a sentence the form can show. A
   * RECORDED time is not a scheduled one: the check-in stamp on `/times` is when something
   * happened and is left at minute precision.
   */
  it("refuses a scheduled time off the five-minute grid on every route that takes one, and only those", async () => {
    const offGrid = "2032-01-21T17:07:00.000Z"; // 09:07 local
    const fiveMinute = /five-minute/;
    const booked = await create(ownerCookie, employeeA, offGrid);
    expect(booked.statusCode, booked.body).toBe(400);
    expect(booked.body).toMatch(fiveMinute);

    const onGrid = await create(ownerCookie, employeeA, "2032-01-21T17:00:00.000Z");
    expect(onGrid.statusCode, onGrid.body).toBe(201);
    const moved = await app.inject({
      method: "PATCH", url: `/api/appointments/${onGrid.json().id}/schedule`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { employeeId: employeeA, localStart: "2032-01-21T10:07", expectedLocationVersion: 1, version: onGrid.json().version }
    });
    expect(moved.statusCode, moved.body).toBe(400);
    expect(moved.body).toMatch(fiveMinute);

    const blockPayload = (localStart: string, localEnd: string) => ({
      employeeId: employeeA, locationId, localStart, localEnd, expectedLocationVersion: 1, reason: "Grid"
    });
    for (const [localStart, localEnd] of [["2032-01-22T12:07", "2032-01-22T13:00"], ["2032-01-22T12:00", "2032-01-22T13:01"]]) {
      const block = await app.inject({
        method: "POST", url: "/api/blocked-times", headers: { cookie: ownerCookie },
        payload: blockPayload(localStart!, localEnd!)
      });
      expect(block.statusCode, block.body).toBe(400);
      expect(block.body).toMatch(fiveMinute);
    }
    const block = await app.inject({
      method: "POST", url: "/api/blocked-times", headers: { cookie: ownerCookie },
      payload: blockPayload("2032-01-22T12:00", "2032-01-22T13:00")
    });
    expect(block.statusCode, block.body).toBe(201);
    const nudged = await app.inject({
      method: "PATCH", url: `/api/blocked-times/${block.json().id}`, headers: { cookie: ownerCookie },
      payload: {
        version: block.json().version, employeeId: employeeA,
        localStart: "2032-01-22T12:05", localEnd: "2032-01-22T13:03", expectedLocationVersion: 1
      }
    });
    expect(nudged.statusCode, nudged.body).toBe(400);
    expect(nudged.body).toMatch(fiveMinute);

    // The recorded check-in is an instant, not a grid time.
    const checkedIn = await app.inject({
      method: "POST", url: `/api/appointments/${onGrid.json().id}/transition`,
      headers: { cookie: ownerCookie }, payload: { status: "checked_in" }
    });
    expect(checkedIn.statusCode, checkedIn.body).toBe(200);
    const corrected = await app.inject({
      method: "PATCH", url: `/api/appointments/${onGrid.json().id}/times`,
      headers: { cookie: ownerCookie },
      payload: { checkedInAt: "2026-01-05T10:07:00.000Z", checkedOutAt: null }
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
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
    // 16:55Z is 08:55 in the salon's own clock - one grid mark before the shift starts. The refusal
    // names WHICH boundary stopped it, which is the whole point of the four codes: this one is the
    // groomer's hours, and the blocked-time case below is not.
    const beforeShift = await create(ownerCookie, employeeA, "2032-01-14T16:55:00.000Z");
    expect(beforeShift.statusCode, beforeShift.body).toBe(409);
    expect(beforeShift.json().code).toBe("OUTSIDE_STAFF_HOURS");
    expect((await create(ownerCookie, employeeA, "2032-01-14T17:00:00.000Z")).statusCode).toBe(201);
    expect((await create(ownerCookie, employeeA, "2032-01-15T00:00:00.000Z")).statusCode).toBe(201);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/blocked-times",
      headers: { cookie: ownerCookie },
      payload: {
        employeeId: employeeA,
        locationId,localStart: "2032-01-15T12:00",localEnd: "2032-01-15T13:00",expectedLocationVersion:1,
        reason: "D1 blocked interval"
      }
    });
    expect(blocked.statusCode).toBe(201);
    // 20:00Z is 12:00 locally, inside the shift and inside the block. Same status as the case
    // above and a DIFFERENT code, so the two are no longer indistinguishable to a caller.
    const onBlock = await create(ownerCookie, employeeA, "2032-01-15T20:00:00.000Z");
    expect(onBlock.statusCode, onBlock.body).toBe(409);
    expect(onBlock.json().code).toBe("TIME_BLOCKED");
    // AND THE FLAG DOES NOT CLEAR IT. This assertion was inverted deliberately: it used to expect
    // 201 here, because `availabilityOverrideMayBypass` returned true for `fully_blocked`. A block
    // is now hard - somebody spoke for that half hour on purpose, and the way past it is to move
    // or delete the block rather than to book invisibly on top of it. `canOverride: false` is
    // returned with the refusal so no client offers a control the server would refuse, and it is
    // false for an OWNER, because the answer is about the rule and not about the caller.
    const overridden = await create(ownerCookie, employeeA, "2032-01-15T20:00:00.000Z", {
      availabilityOverride: true,
      overrideReason: "Owner-approved blocked-time exception"
    });
    expect(overridden.statusCode, overridden.body).toBe(409);
    expect(overridden.json()).toMatchObject({ code: "TIME_BLOCKED", canOverride: false });
    // The ordinary-hours refusal IS still bypassable by the same flag, on the same salon, through
    // the same route - so the case above is the block being hard rather than the override having
    // quietly stopped working. 2032-01-16T01:00Z is 17:00 local the evening before, one minute
    // past the end of a 09:00-17:00 shift and clear of every fixture booked above.
    const afterShift = await create(ownerCookie, employeeA, "2032-01-16T01:00:00.000Z");
    expect(afterShift.statusCode, afterShift.body).toBe(409);
    expect(afterShift.json()).toMatchObject({ code: "OUTSIDE_STAFF_HOURS", canOverride: true });
    const afterShiftForced = await create(ownerCookie, employeeA, "2032-01-16T01:00:00.000Z", {
      availabilityOverride: true,
      overrideReason: "Owner-approved late finish"
    });
    expect(afterShiftForced.statusCode, afterShiftForced.body).toBe(201);
  });

  it("keeps the seven-day calendar bounded and deterministically ordered at the pilot envelope", async () => {
    const [owner] = await db<{ id: string }[]>`
      select user_id as id from business_memberships
      where business_id=${businessId} and is_owner
    `;
    await db`
      insert into appointments
        (business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      select
        ${businessId},${locationId},${customerId},${petId},
        case when series.value % 2=0 then ${employeeA}::uuid else ${employeeB}::uuid end,
        '2032-02-02T17:00:00.000Z'::timestamptz
          + floor(series.value/2) * interval '15 minutes',
        '2032-02-02T17:00:00.000Z'::timestamptz
          + floor(series.value/2) * interval '15 minutes' + interval '60 minutes',
        'America/Los_Angeles',('2032-02-02T17:00:00.000Z'::timestamptz + floor(series.value/2) * interval '15 minutes') at time zone 'America/Los_Angeles',-480,
        'completed',${owner!.id},${owner!.id}
      from generate_series(0,524) as series(value)
    `;
    await db`
      insert into appointments
        (business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      values (
        ${businessId},${locationId},${customerId},${petId},${employeeA},
        '2032-03-01T17:00:00.000Z','2032-03-01T18:00:00.000Z','America/Los_Angeles','2032-03-01T09:00:00',-480,'completed',
        ${owner!.id},${owner!.id}
      )
    `;

    const startedAt = performance.now();
    const response = await app.inject({
      method: "GET",
      url: "/api/appointments?localDate=2032-02-02&days=7",
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

  it("enforces authoritative DST and bounded calendar contracts", async () => {
    const common={locationId,customerId,petId,employeeId:employeeA,serviceIds:[serviceId],expectedLocationVersion:1,
      availabilityOverride:true,overrideReason:"E1 DST coverage"};
    const nonexistent=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{...common,localStart:"2026-03-08T02:30"}});
    expect(nonexistent.statusCode).toBe(400);
    expect(nonexistent.json().code).toBe("NONEXISTENT_LOCAL_TIME");
    const ambiguous=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{...common,localStart:"2026-11-01T01:30"}});
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.json().code).toBe("AMBIGUOUS_LOCAL_TIME");
    expect((await app.inject({method:"GET",url:"/api/appointments?localDate=2026-01-01&days=32",headers:{cookie:ownerCookie}})).statusCode).toBe(400);
    expect((await app.inject({method:"GET",url:"/api/appointments?localDate=not-a-date&days=7",headers:{cookie:ownerCookie}})).statusCode).toBe(400);
  });

  it("durably replays create requests, rejects key reuse, and survives response loss", async()=>{
    const payload=schedulePayload(employeeA,"2032-03-10T17:00:00.000Z");
    const missing=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie},payload});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const key=crypto.randomUUID();
    const send=(body=payload)=>app.inject({method:"POST",url:"/api/appointments",
      headers:{cookie:ownerCookie,"idempotency-key":key},payload:body});
    const first=await send();
    const replay=await send();
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({id:first.json().id,version:first.json().version,scheduledLocalStart:payload.localStart});
    const reused=await send({...payload,localStart:"2032-03-10T11:00"});
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    const [counts]=await db<{appointments:number;replays:number;audits:number;outbox:number}[]>`
      select
        (select count(*)::integer from appointments where id=${first.json().id}) appointments,
        (select count(*)::integer from scheduling_request_replays where business_id=${businessId} and idempotency_key=${key}) replays,
        (select count(*)::integer from audit_events where business_id=${businessId} and resource_id=${first.json().id} and action='appointment.create') audits,
        (select count(*)::integer from outbox_events where business_id=${businessId} and resource_id=${first.json().id} and event_type='AppointmentCreated') outbox
    `;
    expect(counts).toEqual({appointments:1,replays:1,audits:1,outbox:1});
    await db`update business_memberships set role_id=${await roleFor(db, businessId, ["appointments.create","appointments.view"])} where id=${memberId}`;
    const crossActor=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:memberCookie,"idempotency-key":key},payload});
    expect(crossActor.statusCode).toBe(200);
    await db`update business_memberships set role_id=${await roleFor(db, businessId, ["appointments.create"])} where id=${memberId}`;
    const viewRevoked=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:memberCookie,"idempotency-key":key},payload});
    expect(viewRevoked.statusCode).toBe(403);
    expect(viewRevoked.json().code).toBe("PERMISSION_DENIED");

    const lossKey=crypto.randomUUID();
    const lossPayload=schedulePayload(employeeA,"2032-03-11T17:00:00.000Z");
    failAfterCommit="create";
    const lost=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":lossKey},payload:lossPayload});
    expect(lost.statusCode).toBe(400);
    const recovered=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":lossKey},payload:lossPayload});
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().id).toBeTruthy();
  });

  it("serializes concurrent create replay and returns immutable reschedule results",async()=>{
    let reached!:()=>void;const winnerClaimed=new Promise<void>(resolve=>{reached=resolve;});
    let release!:()=>void;const rollBackWinner=new Promise<void>(resolve=>{release=resolve;});
    claimRollbackGate={reached,wait:rollBackWinner};
    const rollbackKey=crypto.randomUUID();
    const rollbackPayload=schedulePayload(employeeA,"2032-03-09T17:00:00.000Z");
    const winner=app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":rollbackKey},payload:rollbackPayload});
    await winnerClaimed;
    const waiter=app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":rollbackKey},payload:rollbackPayload});
    release();
    const [rolledBack,claimed]=await Promise.all([winner,waiter]);
    expect(rolledBack.statusCode).toBe(400);
    expect(claimed.statusCode).toBe(201);
    const [rollbackCounts]=await db<{appointments:number;replays:number}[]>`
      select
        (select count(*)::integer from appointments where business_id=${businessId}
          -- Compared through ::text::timestamp, never as a bare bind. postgres.js serialises
          -- anything bound to a timestamp parameter through new Date(x).toISOString(), so a
          -- zone-less string would be shifted by the TEST HOST's offset and this count would be
          -- zero on every machine that is not UTC. See tests/database/appointment-local-wall-clock.
          and scheduled_local_start=(${rollbackPayload.localStart}::text)::timestamp) appointments,
        (select count(*)::integer from scheduling_request_replays where business_id=${businessId} and idempotency_key=${rollbackKey}) replays
    `;
    expect(rollbackCounts).toEqual({appointments:1,replays:1});

    const concurrentKey=crypto.randomUUID();
    const concurrentPayload=schedulePayload(employeeA,"2032-03-12T17:00:00.000Z");
    const send=()=>app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":concurrentKey},payload:concurrentPayload});
    const [left,right]=await Promise.all([send(),send()]);
    expect([left.statusCode,right.statusCode].sort()).toEqual([200,201]);
    expect(left.json().id).toBe(right.json().id);

    const created=await create(ownerCookie,employeeA,"2032-03-13T17:00:00.000Z");
    const firstKey=crypto.randomUUID();
    const firstMove={employeeId:employeeB,localStart:"2032-03-13T11:00",expectedLocationVersion:1,version:created.json().version};
    failAfterCommit="reschedule";
    const lost=await app.inject({method:"PATCH",url:`/api/appointments/${created.json().id}/schedule`,headers:{cookie:ownerCookie,"idempotency-key":firstKey},payload:firstMove});
    expect(lost.statusCode).toBe(400);
    const replay=await app.inject({method:"PATCH",url:`/api/appointments/${created.json().id}/schedule`,headers:{cookie:ownerCookie,"idempotency-key":firstKey},payload:firstMove});
    expect(replay.statusCode).toBe(200);
    const originalResult=replay.json();
    const secondMove={employeeId:employeeA,localStart:"2032-03-13T13:00",expectedLocationVersion:1,version:originalResult.version};
    const movedAgain=await app.inject({method:"PATCH",url:`/api/appointments/${created.json().id}/schedule`,headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:secondMove});
    expect(movedAgain.statusCode).toBe(200);
    const oldReplay=await app.inject({method:"PATCH",url:`/api/appointments/${created.json().id}/schedule`,headers:{cookie:ownerCookie,"idempotency-key":firstKey},payload:firstMove});
    expect(oldReplay.json()).toMatchObject({id:created.json().id,version:originalResult.version,startAt:originalResult.startAt,employeeId:employeeB});
    const [current]=await db<{version:number;employeeId:string}[]>`select version,employee_id from appointments where id=${created.json().id}`;
    expect(current).toMatchObject({version:movedAgain.json().version,employeeId:employeeA});
  });

  it("records bounded E3 claim and replay diagnostics",async()=>{
    const createMs:number[]=[];const replayMs:number[]=[];
    for(let sample=0;sample<5;sample+=1){
      const key=crypto.randomUUID();
      const payload=schedulePayload(employeeB,`2032-03-${String(20+sample).padStart(2,"0")}T17:00:00.000Z`);
      let started=performance.now();
      const created=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":key},payload});
      createMs.push(performance.now()-started);
      expect(created.statusCode).toBe(201);
      started=performance.now();
      const replay=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":key},payload});
      replayMs.push(performance.now()-started);
      expect(replay.statusCode).toBe(200);
    }
    const [storage]=await db<{rows:number;averageRowBytes:number}[]>`
      select count(*)::integer rows,coalesce(avg(pg_column_size(replay)),0)::integer average_row_bytes
      from scheduling_request_replays replay where business_id=${businessId}
    `;
    const summary=(values:number[])=>({medianMs:Number([...values].sort((a,b)=>a-b)[2]!.toFixed(2)),
      rangeMs:[Number(Math.min(...values).toFixed(2)),Number(Math.max(...values).toFixed(2))]});
    console.info("E3_SCHEDULING_REPLAY_DIAGNOSTICS",JSON.stringify({
      environment:"CI PostgreSQL/API injection; browser startup excluded",sampleCount:5,
      create:summary(createMs),replay:summary(replayMs),rowsInIsolatedBusiness:storage?.rows,
      averageRowBytes:storage?.averageRowBytes,lookupIndex:"unique business_id, operation, idempotency_key"
    }));
  });

  it("validates and version-protects audited location timezone settings", async () => {
    const base={name:"D1 Scheduling",timezone:"America/Los_Angeles",currency:"USD",taxRateBasisPoints:0,reminderLeadMinutes:1440};
    const invalid=await app.inject({method:"PUT",url:"/api/business/settings",headers:{cookie:ownerCookie},payload:{...base,timezone:"Not/A_Zone",locationVersion:1}});
    expect(invalid.statusCode).toBe(400);
    const stale=await app.inject({method:"PUT",url:"/api/business/settings",headers:{cookie:ownerCookie},payload:{...base,locationVersion:999}});
    expect(stale.statusCode).toBe(409);
    let reached!:()=>void;const locked=new Promise<void>(resolve=>{reached=resolve;});
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    locationLockGate={reached,wait};
    const creating=create(ownerCookie,employeeA,"2032-04-01T17:00:00.000Z");
    await locked;
    const changing=app.inject({method:"PUT",url:"/api/business/settings",headers:{cookie:ownerCookie},payload:{...base,timezone:"America/Denver",locationVersion:1}});
    release();
    const [created,changed]=await Promise.all([creating,changing]);
    expect(created.statusCode).toBe(201);
    expect(changed.statusCode).toBe(200);
    const [location,appointment,audits]=await Promise.all([
      db<{version:number;timezone:string}[]>`select version,timezone from locations where id=${locationId}`,
      db<{schedulingTimezone:string}[]>`select scheduling_timezone from appointments where id=${created.json().id}`,
      db`select id from audit_events where business_id=${businessId} and action='business.settings.update'`
    ]);
    expect(location[0]).toMatchObject({version:2,timezone:"America/Denver"});
    expect(appointment[0]?.schedulingTimezone).toBe("America/Los_Angeles");
    expect(audits).toHaveLength(1);
  });
});
