import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { roleFor } from "../support/roles.js";

/**
 * The two scheduling overrides, and who is allowed to use them, on BOTH routes that write them.
 *
 * `appointments.override_conflict` gates the conflict override. `appointments.edit` gates the
 * availability override - booking a groomer outside the hours they work. Only two handlers ever
 * write `appointments.availability_overridden` or `conflict_overridden`: `POST /api/appointments`
 * and `PATCH /api/appointments/:id/schedule`.
 *
 * The pair is asymmetric on the page and symmetric in effect, which is worth a suite rather than a
 * reading, because the asymmetry is exactly the shape a real missing check has:
 *
 *   create      preHandler `appointments.create`, then an INLINE
 *               `isOwner || permissions.includes("appointments.edit")` on the override
 *   reschedule  preHandler `appointments.edit`, and no inline check
 *
 * `requirePermission(p)` is `can(auth, p)`, which is `auth.isOwner || auth.permissions.includes(p)`
 * - the same predicate, character for character, that create applies inline. So the reschedule
 * route enforces it for the WHOLE route, before the body is parsed, and create must repeat it
 * inline only because its own preHandler names a different permission. These tests pin that
 * equivalence from the outside, so it stays true if either preHandler is ever changed.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "appointment-override-authority-secret-32-ch",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const sessionCookie = (response: { headers: Record<string, unknown> }) => {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
};

describeDatabase("scheduling override authority, on both routes that write it", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string, editorCookie: string, creatorCookie: string, plainEditorCookie: string;
  let businessId: string, locationId: string, customerId: string, petId: string;
  let serviceId: string, employeeId: string;
  const suffix = crypto.randomUUID().slice(0, 8);

  /** Inside the groomer's working hours. */
  const withinHours = (day: string) => `${day}T10:00`;
  /** Outside them, so the availability override is what decides the request. */
  const outsideHours = (day: string) => `${day}T20:00`;

  const create = (cookie: string, localStart: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId, serviceIds: [serviceId],
        localStart, expectedLocationVersion: 1, ...extra
      }
    });

  const move = (cookie: string, id: string, localStart: string, version: number, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "PATCH", url: `/api/appointments/${id}/schedule`,
      headers: { cookie, "idempotency-key": crypto.randomUUID() },
      payload: { employeeId, localStart, version, expectedLocationVersion: 1, ...extra }
    });

  const stored = async (id: string) => {
    const [row] = await db<{
      startAt: Date; version: number; availabilityOverridden: boolean; conflictOverridden: boolean;
    }[]>`
      select start_at,version,availability_overridden,conflict_overridden
      from appointments where business_id=${businessId} and id=${id}
    `;
    return row!;
  };

  /** An appointment inside working hours, created by the owner, ready to be moved. */
  const scheduled = async (day: string) => {
    const created = await create(ownerCookie, withinHours(day));
    expect(created.statusCode, created.body).toBe(201);
    return { id: created.json().id as string, version: created.json().version as number };
  };

  const seedMember = async (label: string, permissions: readonly string[]) => {
    const email = `override-${label}-${suffix}@example.test`;
    const password = `correct horse override ${label}`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash)
      values (${email},${email},${await hashPassword(password)}) returning id
    `;
    await db`
      insert into business_memberships(business_id,user_id,role_id)
      values (${businessId},${user!.id},${await roleFor(db, businessId, permissions)})
    `;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    expect(login.statusCode, login.body).toBe(200);
    return sessionCookie(login);
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `override-owner-${suffix}@example.test`,
      password: "correct horse override owner", businessName: `Override Salon ${suffix}`
    }});
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = sessionCookie(signup);
    ({ businessId, locationId } = signup.json());

    serviceId = (await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name: `Override Groom ${suffix}`, baseDurationMinutes: 60, basePriceMinor: 7000 }
    })).json().id;
    employeeId = (await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: `Override Groomer ${suffix}`, serviceIds: [serviceId] }
    })).json().id;
    customerId = (await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName: "Override", lastName: "Client", preferredContactMethod: "none", emailAllowed: false }
    })).json().id;
    petId = (await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Override Pet", species: "dog" }
    })).json().id;

    // Without working hours a groomer is available at every hour, and the override would never be
    // the thing deciding the request. Nine to five, every day, so the fixture dates below do not
    // have to care which weekday they land on.
    for (let weekday = 0; weekday < 7; weekday += 1) {
      await db`
        insert into employee_working_hours(business_id,employee_id,weekday,start_time,end_time)
        values (${businessId},${employeeId},${weekday},'09:00','17:00')
      `;
    }

    editorCookie = await seedMember("editor",
      ["calendar.view", "appointments.view", "appointments.create", "appointments.edit", "appointments.override_conflict"]);
    // Holds `appointments.create` and NOT `appointments.edit`: the caller the availability
    // override on create exists to refuse.
    creatorCookie = await seedMember("creator",
      ["calendar.view", "appointments.view", "appointments.create"]);
    // Holds `appointments.edit` and NOT `appointments.override_conflict`.
    plainEditorCookie = await seedMember("plain-editor",
      ["calendar.view", "appointments.view", "appointments.create", "appointments.edit"]);
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it("refuses an unavailable time when nobody asks for the override", async () => {
    const refused = await create(ownerCookie, outsideHours("2033-03-07"));
    // 409 and a NAMED reason, not the bare 400 this used to fall through to. 20:00 is past a
    // 17:00 finish, so the groomer's own hours are what refused it, and `canOverride` says the
    // Owner could have asked for the override that would have got past them.
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "OUTSIDE_STAFF_HOURS", employeeId, localDate: "2033-03-07", canOverride: true
    });
    const [count] = await db<{ count: number }[]>`
      select count(*)::int count from appointments where business_id=${businessId} and employee_id=${employeeId}
        and scheduled_local_start='2033-03-07 20:00:00'
    `;
    expect(count?.count).toBe(0);
  });

  it("lets an Owner book outside availability with the override", async () => {
    const created = await create(ownerCookie, outsideHours("2033-03-08"), {
      availabilityOverride: true, overrideReason: "Client can only make the evening"
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(await stored(created.json().id)).toMatchObject({ availabilityOverridden: true });
  });

  it("refuses the availability override on CREATE to a caller without appointments.edit", async () => {
    const refused = await create(creatorCookie, outsideHours("2033-03-09"), {
      availabilityOverride: true, overrideReason: "Squeezing them in"
    });
    // `appointments.create` gets them through the door; the override needs `appointments.edit`
    // as well, and this caller has only the first.
    //
    // 403 AND THE SAME BODY THE RESCHEDULE ROUTE SENDS. This was a bare `throw new Error`, which
    // the handler renders as a 400 - the status for a malformed request, sent to a caller whose
    // request was fine and who simply is not allowed to make it. The two routes enforce one
    // authority and now answer with one shape, which is the property this suite exists to hold.
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({
      code: "PERMISSION_DENIED", error: "Missing permission: appointments.edit"
    });
    const [count] = await db<{ count: number }[]>`
      select count(*)::int count from appointments where business_id=${businessId}
        and scheduled_local_start='2033-03-09 20:00:00'
    `;
    expect(count?.count).toBe(0);
  });

  it("refuses the availability override on RESCHEDULE to the same caller", async () => {
    const appointment = await scheduled("2033-03-10");
    const refused = await move(creatorCookie, appointment.id, outsideHours("2033-03-10"), appointment.version, {
      availabilityOverride: true, overrideReason: "Squeezing them in"
    });
    // The authority is the same one the create path demands; the reschedule route enforces it in
    // its preHandler, for the whole route, rather than inline on the flag.
    expect(refused.statusCode, refused.body).toBe(403);
    // The SENTENCE is identical to the one create sends; the body is not, and the difference is
    // where the check sits rather than what it enforces. Create refuses inline with a
    // `SchedulingRequestError`, which carries a `code`; this route never reaches the handler at
    // all, because `requirePermission` answers in the preHandler with `{ error }` alone.
    expect(refused.json()).toMatchObject({ error: "Missing permission: appointments.edit" });
    expect(refused.json().code).toBeUndefined();
    // Nothing moved, and nothing was marked as overridden.
    expect(await stored(appointment.id)).toMatchObject({
      version: appointment.version, availabilityOverridden: false
    });
  });

  it("refuses a RESCHEDULE onto unavailable time even without the override flag", async () => {
    const appointment = await scheduled("2033-03-11");
    const refused = await move(plainEditorCookie, appointment.id, outsideHours("2033-03-11"), appointment.version);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: "OUTSIDE_STAFF_HOURS", canOverride: true });
    expect(await stored(appointment.id)).toMatchObject({ version: appointment.version });
  });

  it("lets a caller holding appointments.edit reschedule onto unavailable time with the override", async () => {
    const appointment = await scheduled("2033-03-12");
    const moved = await move(plainEditorCookie, appointment.id, outsideHours("2033-03-12"), appointment.version, {
      availabilityOverride: true, overrideReason: "Client can only make the evening"
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await stored(appointment.id)).toMatchObject({ availabilityOverridden: true });
  });

  it("requires a written reason for the override on both routes", async () => {
    const onCreate = await create(ownerCookie, outsideHours("2033-03-13"), { availabilityOverride: true });
    expect(onCreate.statusCode, onCreate.body).toBe(400);
    const appointment = await scheduled("2033-03-14");
    const onMove = await move(ownerCookie, appointment.id, outsideHours("2033-03-14"), appointment.version, {
      availabilityOverride: true
    });
    expect(onMove.statusCode, onMove.body).toBe(400);
  });

  describe("the conflict override is gated identically on both routes", () => {
    it("refuses it on CREATE without appointments.override_conflict", async () => {
      const refused = await create(plainEditorCookie, withinHours("2033-03-15"), { overrideConflict: true });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({
        code: "PERMISSION_DENIED", error: "Missing permission: appointments.override_conflict"
      });
    });

    it("refuses it on RESCHEDULE without appointments.override_conflict", async () => {
      const appointment = await scheduled("2033-03-16");
      const refused = await move(plainEditorCookie, appointment.id, withinHours("2033-03-17"), appointment.version, {
        overrideConflict: true
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({
        code: "PERMISSION_DENIED", error: "Missing permission: appointments.override_conflict"
      });
      expect(await stored(appointment.id)).toMatchObject({ version: appointment.version });
    });

    it("accepts it on both routes from a caller who holds the permission", async () => {
      const created = await create(editorCookie, withinHours("2033-03-18"), { overrideConflict: true });
      expect(created.statusCode, created.body).toBe(201);
      const moved = await move(editorCookie, created.json().id, withinHours("2033-03-19"), created.json().version, {
        overrideConflict: true
      });
      expect(moved.statusCode, moved.body).toBe(200);
    });
  });
});
