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
  SESSION_SECRET: "staff-availability-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000",
  SMTP_PORT: 587,
  SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }): string =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("staff availability", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string, foreignCookie: string, schedulerCookie: string;
  let businessId: string, foreignBusinessId: string;
  let locationId: string, foreignLocationId: string;
  let employeeA: string, employeeB: string, unscheduled: string;
  let serviceId: string, customerId: string, petId: string;

  const suffix = crypto.randomUUID();

  /** Read the authoritative version rather than counting the writes that moved it. */
  async function locationVersion(sessionCookie = ownerCookie): Promise<number> {
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionCookie } });
    return me.json().business.locationVersion as number;
  }

  async function book(localStart: string, extra: object = {}) {
    return app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId: employeeA, serviceIds: [serviceId],
        localStart, expectedLocationVersion: await locationVersion(), ...extra
      }
    });
  }

  const saveClosures = (month: string, closedDates: string[], sessionCookie = ownerCookie, location = locationId) =>
    app.inject({
      method: "PUT", url: `/api/locations/${location}/closure-days`,
      headers: { cookie: sessionCookie }, payload: { month, closedDates }
    });

  const readClosures = (from: string, to: string, sessionCookie = ownerCookie, location = locationId) =>
    app.inject({
      method: "GET", url: `/api/locations/${location}/closure-days?from=${from}&to=${to}`,
      headers: { cookie: sessionCookie }
    });

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `availability-owner-${suffix}@example.test`,
        password: "correct horse availability owner",
        businessName: "Availability Salon"
      }
    });
    expect(signup.statusCode).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());

    serviceId = (await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name: "Availability Groom", baseDurationMinutes: 60, basePriceMinor: 7000 }
    })).json().id;

    const employee = async (displayName: string) => (await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName, serviceIds: [serviceId] }
    })).json().id as string;
    employeeA = await employee("Availability Groomer A");
    employeeB = await employee("Availability Groomer B");
    unscheduled = await employee("Never Configured");

    customerId = (await app.inject({
      method: "POST", url: "/api/customers",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { firstName: "Ava", lastName: "Client", preferredContactMethod: "none", emailAllowed: false }
    })).json().id;
    petId = (await app.inject({
      method: "POST", url: "/api/pets",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { customerId, name: "Biscuit", species: "dog" }
    })).json().id;

    const foreign = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `availability-foreign-${suffix}@example.test`,
        password: "correct horse availability foreign",
        businessName: "Foreign Salon"
      }
    });
    foreignCookie = cookie(foreign);
    ({ businessId: foreignBusinessId, locationId: foreignLocationId } = foreign.json());

    // A member who can read the calendar but manage nothing.
    const schedulerEmail = `availability-scheduler-${suffix}@example.test`;
    const schedulerPassword = "correct horse availability scheduler";
    const [schedulerUser] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash)
      values (${schedulerEmail},${schedulerEmail},${await hashPassword(schedulerPassword)})
      returning id
    `;
    await db`
      insert into business_memberships(business_id,user_id,permissions)
      values (${businessId},${schedulerUser!.id},${["calendar.view", "appointments.view"]})
    `;
    schedulerCookie = cookie(await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { email: schedulerEmail, password: schedulerPassword }
    }));
  });

  afterAll(async () => { await app.close(); await db.end(); });

  describe("the working-hours grid", () => {
    beforeAll(async () => {
      for (const [id, weekdays] of [[employeeA, [1, 2, 3, 4, 5]], [employeeB, [2, 6]]] as const) {
        const saved = await app.inject({
          method: "PUT", url: `/api/employees/${id}/working-hours`, headers: { cookie: ownerCookie },
          payload: { hours: weekdays.map((weekday) => ({ weekday, startTime: "09:00", endTime: "17:00" })) }
        });
        expect(saved.statusCode).toBe(204);
      }
    });

    it("returns every groomer and every stored day in one response", async () => {
      const response = await app.inject({
        method: "GET", url: "/api/availability/working-hours", headers: { cookie: ownerCookie }
      });
      expect(response.statusCode).toBe(200);
      const employees = response.json().employees as {
        id: string; displayName: string; active: boolean;
        days: { weekday: number; startTime: string; endTime: string; appointmentLimit: number }[];
      }[];
      expect(employees.map((row) => row.id).sort()).toEqual([employeeA, employeeB, unscheduled].sort());
      const a = employees.find((row) => row.id === employeeA)!;
      expect(a.days.map((day) => day.weekday)).toEqual([1, 2, 3, 4, 5]);
      expect(a.days[0]).toEqual({ weekday: 1, startTime: "09:00", endTime: "17:00", appointmentLimit: 1 });
      expect(employees.find((row) => row.id === employeeB)!.days.map((day) => day.weekday)).toEqual([2, 6]);
    });

    // Absent is not closed. A groomer nobody has configured is unrestricted in the booking path,
    // and the grid has to be able to say so rather than painting seven closed days.
    it("returns an empty day list for a groomer with no stored hours", async () => {
      const response = await app.inject({
        method: "GET", url: "/api/availability/working-hours", headers: { cookie: ownerCookie }
      });
      const never = response.json().employees.find((row: { id: string }) => row.id === unscheduled);
      expect(never.days).toEqual([]);
      expect(never.active).toBe(true);
    });

    it("shows no other tenant's groomers", async () => {
      const foreign = await app.inject({
        method: "GET", url: "/api/availability/working-hours", headers: { cookie: foreignCookie }
      });
      expect(foreign.statusCode).toBe(200);
      expect(foreign.json().employees).toEqual([]);
    });

    it("requires a session", async () => {
      expect((await app.inject({ method: "GET", url: "/api/availability/working-hours" })).statusCode).toBe(401);
    });
  });

  describe("the appointment limit", () => {
    it("accepts and stores the only value the database can honour", async () => {
      const saved = await app.inject({
        method: "PUT", url: `/api/employees/${employeeB}/working-hours`, headers: { cookie: ownerCookie },
        payload: { hours: [{ weekday: 2, startTime: "09:00", endTime: "17:00", appointmentLimit: 1 }] }
      });
      expect(saved.statusCode).toBe(204);
      const [row] = await db<{ appointmentLimit: number }[]>`
        select appointment_limit from employee_working_hours
        where business_id=${businessId} and employee_id=${employeeB} and weekday=2
      `;
      expect(row?.appointmentLimit).toBe(1);
    });

    it("defaults to 1 when the editor omits it", async () => {
      const saved = await app.inject({
        method: "PUT", url: `/api/employees/${employeeB}/working-hours`, headers: { cookie: ownerCookie },
        payload: { hours: [{ weekday: 2, startTime: "09:00", endTime: "17:00" }, { weekday: 6, startTime: "09:00", endTime: "17:00" }] }
      });
      expect(saved.statusCode).toBe(204);
      const rows = await db<{ appointmentLimit: number }[]>`
        select appointment_limit from employee_working_hours
        where business_id=${businessId} and employee_id=${employeeB}
      `;
      expect(rows.map((row) => row.appointmentLimit)).toEqual([1, 1]);
    });

    // Concurrency above one is refused by the database triggers, so the API refuses to record a
    // promise it cannot keep - with its own code, not a generic validation error.
    it("refuses any value other than 1 and changes nothing", async () => {
      const before = await db`select weekday,appointment_limit from employee_working_hours
        where business_id=${businessId} and employee_id=${employeeB} order by weekday`;
      const rejected = await app.inject({
        method: "PUT", url: `/api/employees/${employeeB}/working-hours`, headers: { cookie: ownerCookie },
        payload: { hours: [{ weekday: 3, startTime: "10:00", endTime: "12:00", appointmentLimit: 2 }] }
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().code).toBe("LIMIT_NOT_CONFIGURABLE");
      const after = await db`select weekday,appointment_limit from employee_working_hours
        where business_id=${businessId} and employee_id=${employeeB} order by weekday`;
      expect(after).toEqual(before);
    });

    it("still rejects a value outside the stored range at the schema", async () => {
      const rejected = await app.inject({
        method: "PUT", url: `/api/employees/${employeeB}/working-hours`, headers: { cookie: ownerCookie },
        payload: { hours: [{ weekday: 3, startTime: "10:00", endTime: "12:00", appointmentLimit: 99 }] }
      });
      expect(rejected.statusCode).toBe(400);
    });
  });

  describe("closure days", () => {
    it("requires a bounded range to read", async () => {
      const unbounded = await app.inject({
        method: "GET", url: `/api/locations/${locationId}/closure-days`, headers: { cookie: ownerCookie }
      });
      expect(unbounded.statusCode).toBe(400);
      const halfBounded = await app.inject({
        method: "GET", url: `/api/locations/${locationId}/closure-days?from=2032-05-01`, headers: { cookie: ownerCookie }
      });
      expect(halfBounded.statusCode).toBe(400);
      const backwards = await readClosures("2032-05-31", "2032-05-01");
      expect(backwards.statusCode).toBe(400);
    });

    it("replaces one month and leaves every other month alone", async () => {
      expect((await saveClosures("2032-05", ["2032-05-04", "2032-05-05"])).statusCode).toBe(200);
      expect((await saveClosures("2032-06", ["2032-06-10"])).statusCode).toBe(200);

      const may = await saveClosures("2032-05", ["2032-05-05", "2032-05-20"]);
      expect(may.statusCode).toBe(200);
      expect(may.json().closedDates).toEqual(["2032-05-05", "2032-05-20"]);

      const range = await readClosures("2032-05-01", "2032-06-30");
      const closed = range.json().days.filter((day: { closed: boolean }) => day.closed)
        .map((day: { localDate: string }) => day.localDate);
      expect(closed).toEqual(["2032-05-05", "2032-05-20", "2032-06-10"]);
    });

    it("is idempotent: the same save twice changes nothing but the version", async () => {
      const first = await saveClosures("2032-07", ["2032-07-04"]);
      const second = await saveClosures("2032-07", ["2032-07-04"]);
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(second.json().closedDates).toEqual(["2032-07-04"]);
      const [count] = await db<{ count: number }[]>`
        select count(*)::int as count from location_closure_days
        where business_id=${businessId} and location_id=${locationId} and local_date='2032-07-04'
      `;
      expect(count?.count).toBe(1);
    });

    it("clears a month when the list is empty", async () => {
      expect((await saveClosures("2032-08", ["2032-08-01", "2032-08-02"])).statusCode).toBe(200);
      expect((await saveClosures("2032-08", [])).statusCode).toBe(200);
      const range = await readClosures("2032-08-01", "2032-08-31");
      expect(range.json().days.filter((day: { closed: boolean }) => day.closed)).toEqual([]);
    });

    it("refuses a date that does not belong to the month being saved", async () => {
      const rejected = await saveClosures("2032-09", ["2032-10-01"]);
      expect(rejected.statusCode).toBe(400);
    });

    // The booking path detects a stale client through `expectedLocationVersion`, and closures are
    // a booking input. A client holding yesterday's calendar must be told, not quietly allowed to
    // book a day the salon just shut.
    it("bumps the location version so a stale client is caught", async () => {
      const before = await locationVersion();
      const saved = await saveClosures("2032-10", ["2032-10-11"]);
      expect(saved.json().locationVersion).toBe(before + 1);
      expect(await locationVersion()).toBe(before + 1);
      const stale = await app.inject({
        method: "POST", url: "/api/appointments",
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: {
          locationId, customerId, petId, employeeId: employeeA, serviceIds: [serviceId],
          localStart: "2032-10-12T10:00", expectedLocationVersion: before
        }
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("STALE_LOCATION_SETTINGS");
    });

    it("counts the live appointments already sitting on a date", async () => {
      const booked = await book("2032-11-16T10:00");
      expect(booked.statusCode).toBe(201);
      const range = await readClosures("2032-11-01", "2032-11-30");
      const day = range.json().days.find((row: { localDate: string }) => row.localDate === "2032-11-16");
      expect(day).toMatchObject({ localDate: "2032-11-16", closed: false, bookedAppointments: 1 });

      // Cancelling removes it from the count: nothing is stranded by closing that day any more.
      const cancelled = await app.inject({
        method: "POST", url: `/api/appointments/${booked.json().id}/transition`,
        headers: { cookie: ownerCookie },
        payload: { status: "cancelled", version: booked.json().version }
      });
      expect(cancelled.statusCode).toBe(200);
      const after = await readClosures("2032-11-01", "2032-11-30");
      expect(after.json().days.find((row: { localDate: string }) => row.localDate === "2032-11-16")).toBeUndefined();
    });

    it("refuses another tenant's location on read and on write", async () => {
      expect((await readClosures("2032-05-01", "2032-05-31", foreignCookie)).statusCode).toBe(404);
      expect((await saveClosures("2032-05", ["2032-05-05"], foreignCookie)).statusCode).toBe(404);
      const stillOurs = await db<{ count: number }[]>`
        select count(*)::int as count from location_closure_days where business_id=${businessId}
      `;
      expect(stillOurs[0]!.count).toBeGreaterThan(0);
      // And the foreign tenant's own location is genuinely reachable, so 404 above is isolation
      // rather than a broken route.
      expect((await readClosures("2032-05-01", "2032-05-31", foreignCookie, foreignLocationId)).statusCode).toBe(200);
    });

    // A staff member who can see the calendar can see which days the shop is shut; changing them
    // is a settings decision. Asserted with a real second membership rather than by demoting the
    // owner, which the `protect_last_owner` trigger correctly refuses.
    it("requires settings.manage to write while calendar.view is enough to read", async () => {
      expect((await readClosures("2032-05-01", "2032-05-31", schedulerCookie)).statusCode).toBe(200);
      const refused = await saveClosures("2032-05", ["2032-05-05"], schedulerCookie);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toMatch(/settings\.manage/);
      const stillClosed = await readClosures("2032-05-01", "2032-05-31");
      expect(stillClosed.json().days.filter((day: { closed: boolean }) => day.closed)
        .map((day: { localDate: string }) => day.localDate)).toEqual(["2032-05-05", "2032-05-20"]);
    });
  });

  describe("a closure refuses booking", () => {
    beforeAll(async () => {
      expect((await saveClosures("2032-12", ["2032-12-24", "2032-12-25"])).statusCode).toBe(200);
    });

    it("refuses a booking on the closed day with its own code", async () => {
      const refused = await book("2032-12-24T10:00");
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe("LOCATION_CLOSED");
      expect(refused.json().localDate).toBe("2032-12-24");
    });

    // The teeth. An availability override is a judgement about a groomer's hours; it cannot make
    // an unstaffed building open.
    it("refuses it even when the caller asks for an availability override", async () => {
      const refused = await book("2032-12-25T10:00", {
        availabilityOverride: true, overrideReason: "Owner insists"
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe("LOCATION_CLOSED");
      const [count] = await db<{ count: number }[]>`
        select count(*)::int as count from appointments
        where business_id=${businessId}
          and (start_at at time zone scheduling_timezone)::date='2032-12-25'
      `;
      expect(count?.count).toBe(0);
    });

    it("refuses it with a conflict override too", async () => {
      const refused = await book("2032-12-25T11:00", {
        availabilityOverride: true, overrideConflict: true, overrideReason: "Owner insists harder"
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe("LOCATION_CLOSED");
    });

    it("still books the day either side of the closure", async () => {
      // Both Thursdays, inside the groomer's Mon-Fri hours, either side of the closed week.
      expect((await book("2032-12-23T10:00")).statusCode).toBe(201);
      expect((await book("2032-12-30T10:00")).statusCode).toBe(201);
    });

    it("refuses a reschedule onto a closed day and leaves the appointment where it was", async () => {
      const booked = await book("2032-12-27T10:00");
      expect(booked.statusCode).toBe(201);
      const moved = await app.inject({
        method: "PATCH", url: `/api/appointments/${booked.json().id}/schedule`,
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: {
          employeeId: employeeA, localStart: "2032-12-24T13:00",
          expectedLocationVersion: await locationVersion(), version: booked.json().version,
          availabilityOverride: true, overrideReason: "Move it anyway"
        }
      });
      expect(moved.statusCode).toBe(409);
      expect(moved.json().code).toBe("LOCATION_CLOSED");
      const [row] = await db<{ localDate: string }[]>`
        select to_char(start_at at time zone scheduling_timezone,'YYYY-MM-DD') as local_date
        from appointments where id=${booked.json().id}
      `;
      expect(row!.localDate).toBe("2032-12-27");
    });

    it("closes only the location it was recorded against", async () => {
      // The second location shares the tenant; closing the first must not close it.
      const [second] = await db<{ id: string }[]>`
        insert into locations(business_id,name,timezone) values (${businessId},'Second Shop','America/Los_Angeles')
        returning id
      `;
      const [closed] = await db<{ count: number }[]>`
        select count(*)::int as count from location_closure_days
        where business_id=${businessId} and location_id=${second!.id}
      `;
      expect(closed?.count).toBe(0);
      await db`delete from locations where id=${second!.id}`;
    });
  });

  // The two dates a year where wall clock and elapsed time disagree. A closure is a calendar date
  // at the salon, so it has to catch the whole of a 23-hour day and the whole of a 25-hour one.
  describe("daylight-saving dates", () => {
    beforeAll(async () => {
      expect((await saveClosures("2032-03", ["2032-03-14"])).statusCode).toBe(200);
      expect((await saveClosures("2032-11", ["2032-11-07"])).statusCode).toBe(200);
    });

    it("refuses bookings across the whole spring-forward day", async () => {
      for (const localStart of ["2032-03-14T01:00", "2032-03-14T04:00", "2032-03-14T22:00"]) {
        const refused = await book(localStart, { availabilityOverride: true, overrideReason: "DST" });
        expect(refused.statusCode, localStart).toBe(409);
        expect(refused.json().code, localStart).toBe("LOCATION_CLOSED");
      }
      // 23:00 on the previous day is outside the closure and books normally.
      expect((await book("2032-03-13T22:00", { availabilityOverride: true, overrideReason: "DST edge" })).statusCode).toBe(201);
    });

    it("refuses bookings on both occurrences of the repeated fall-back hour", async () => {
      for (const disambiguation of ["earlier", "later"] as const) {
        const refused = await book("2032-11-07T01:30", {
          disambiguation, availabilityOverride: true, overrideReason: "DST"
        });
        expect(refused.statusCode, disambiguation).toBe(409);
        expect(refused.json().code, disambiguation).toBe("LOCATION_CLOSED");
      }
      expect((await book("2032-11-08T10:00", { availabilityOverride: true, overrideReason: "DST edge" })).statusCode).toBe(201);
    });
  });

  describe("override counts", () => {
    it("groups by groomer and by the weekday of the salon's own clock", async () => {
      // 2033-01-04 is a Tuesday (weekday 2) in the salon's timezone. Booked at 22:30 local, an
      // hour that has already rolled over to Wednesday in UTC - the count must still land on
      // Tuesday, or the grid marks the wrong column for every late-evening booking.
      const late = await book("2033-01-04T22:30", { availabilityOverride: true, overrideReason: "Late finish" });
      expect(late.statusCode).toBe(201);
      const [stored] = await db<{ startAt: Date }[]>`select start_at from appointments where id=${late.json().id}`;
      expect(stored!.startAt.getUTCDay()).toBe(3); // Wednesday in UTC...

      const response = await app.inject({
        method: "GET", url: "/api/availability/override-counts", headers: { cookie: ownerCookie }
      });
      expect(response.statusCode).toBe(200);
      const counts = response.json() as { employeeId: string; weekday: number; count: number }[];
      const tuesday = counts.find((row) => row.employeeId === employeeA && row.weekday === 2);
      expect(tuesday, JSON.stringify(counts)).toBeDefined(); // ...but Tuesday in the grid.
      expect(tuesday!.count).toBeGreaterThanOrEqual(1);
      expect(counts.every((row) => row.weekday >= 0 && row.weekday <= 6)).toBe(true);
    });

    it("drops an appointment from the count when it is cancelled", async () => {
      const booked = await book("2033-02-01T21:00", { availabilityOverride: true, overrideReason: "Counted" });
      expect(booked.statusCode).toBe(201);
      const countFor = async () => {
        const rows = (await app.inject({
          method: "GET", url: "/api/availability/override-counts", headers: { cookie: ownerCookie }
        })).json() as { employeeId: string; weekday: number; count: number }[];
        // 2033-02-01 is a Tuesday.
        return rows.find((row) => row.employeeId === employeeA && row.weekday === 2)?.count ?? 0;
      };
      const before = await countFor();
      const cancelled = await app.inject({
        method: "POST", url: `/api/appointments/${booked.json().id}/transition`,
        headers: { cookie: ownerCookie },
        payload: { status: "cancelled", version: booked.json().version }
      });
      expect(cancelled.statusCode).toBe(200);
      expect(await countFor()).toBe(before - 1);
    });

    it("shows another tenant nothing", async () => {
      const foreign = await app.inject({
        method: "GET", url: "/api/availability/override-counts", headers: { cookie: foreignCookie }
      });
      expect(foreign.statusCode).toBe(200);
      expect(foreign.json()).toEqual([]);
    });
  });

  describe("salon hours move the location version", () => {
    it("bumps it so a client cannot book against a grid that no longer exists", async () => {
      const before = await locationVersion();
      const saved = await app.inject({
        method: "PUT", url: "/api/business/working-hours",
        headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
        payload: { hours: [{ weekday: 1, startTime: "09:00", endTime: "17:00" }] }
      });
      expect(saved.statusCode).toBe(200);
      expect(await locationVersion()).toBe(before + 1);
      const stale = await app.inject({
        method: "POST", url: "/api/appointments",
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: {
          locationId, customerId, petId, employeeId: employeeA, serviceIds: [serviceId],
          localStart: "2033-03-07T10:00", expectedLocationVersion: before,
          availabilityOverride: true, overrideReason: "Stale check"
        }
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("STALE_LOCATION_SETTINGS");
      // Clear the grid again so it cannot bound the rest of the suite.
      expect((await app.inject({
        method: "PUT", url: "/api/business/working-hours",
        headers: { cookie: ownerCookie, origin: config.APP_ORIGIN }, payload: { hours: [] }
      })).statusCode).toBe(200);
    });
  });

  /**
   * Row-level security, asserted at the table rather than through the API.
   *
   * The `tenant_isolation` loop in 0001 is a one-time `do` block over a fixed array of table
   * names. It cannot cover a table created in 0027, so a migration that forgot the policy would
   * still pass every route test in this file - the routes filter by `business_id` themselves, and
   * RLS is the layer underneath that catches the query which forgets to.
   *
   * The application connects as the database owner, which PostgreSQL exempts from RLS, so the
   * policies are checked here under a role they actually apply to. That is the only way to tell a
   * present policy from an absent one.
   */
  describe("row-level security on the new tables", () => {
    const probeRole = "pawsh_availability_rls_probe";

    beforeAll(async () => {
      await db.unsafe(`do $$ begin
        if not exists (select 1 from pg_roles where rolname='${probeRole}') then
          create role ${probeRole} nologin;
        end if;
      end $$`);
      await db.unsafe(
        `grant select, insert on location_closure_days, employee_date_availability to ${probeRole}`
      );
      await db`
        insert into location_closure_days(business_id,location_id,local_date,reason)
        values (${businessId},${locationId},'2034-01-02','RLS probe')
        on conflict do nothing
      `;
      await db`
        insert into employee_date_availability(business_id,employee_id,local_date,working,start_time,end_time)
        values (${businessId},${employeeA},'2034-01-02',true,'09:00','17:00')
        on conflict (employee_id,local_date) do update set updated_at=now()
      `;
    });

    // Guards the specific mistake the 0001 loop invites: a new table with RLS switched on and no
    // policy behind it, or no RLS at all.
    it("carries the same tenant_isolation policy the established tables carry", async () => {
      const policies = await db<{
        tablename: string; policyname: string; qual: string; withCheck: string;
      }[]>`
        select tablename,policyname,qual,with_check from pg_policies
        where tablename in ('customers','location_closure_days','employee_date_availability')
        order by tablename
      `;
      const established = policies.find((row) => row.tablename === "customers")!;
      expect(established).toBeDefined();
      for (const table of ["location_closure_days", "employee_date_availability"]) {
        const policy = policies.find((row) => row.tablename === table);
        expect(policy, `${table} has no policy`).toBeDefined();
        expect(policy!.policyname).toBe("tenant_isolation");
        expect(policy!.qual, table).toBe(established.qual);
        expect(policy!.withCheck, table).toBe(established.withCheck);
      }
      const enabled = await db<{ relname: string; relrowsecurity: boolean }[]>`
        select relname,relrowsecurity from pg_class
        where relname in ('location_closure_days','employee_date_availability')
      `;
      expect(enabled).toHaveLength(2);
      expect(enabled.every((row) => row.relrowsecurity)).toBe(true);
    });

    it("hides both tables' rows from a transaction running as another tenant", async () => {
      const asForeignTenant = await db.begin(async (tx) => {
        await tx.unsafe(`set local role ${probeRole}`);
        await tx`select set_config('app.business_id',${foreignBusinessId},true)`;
        // Unfiltered reads: without a policy these return the rows inserted above.
        const closures = await tx<{ count: number }[]>`select count(*)::int as count from location_closure_days`;
        const dates = await tx<{ count: number }[]>`select count(*)::int as count from employee_date_availability`;
        // And an explicit attempt to name the other tenant is filtered just the same.
        const targeted = await tx<{ count: number }[]>`
          select count(*)::int as count from location_closure_days where business_id=${businessId}
        `;
        return { closures: closures[0]!.count, dates: dates[0]!.count, targeted: targeted[0]!.count };
      });
      expect(asForeignTenant).toEqual({ closures: 0, dates: 0, targeted: 0 });

      // The positive control: the same role in the owning tenant's context does see them, so the
      // zeroes above are the policy filtering rather than a missing grant.
      const asOwnTenant = await db.begin(async (tx) => {
        await tx.unsafe(`set local role ${probeRole}`);
        await tx`select set_config('app.business_id',${businessId},true)`;
        const closures = await tx<{ count: number }[]>`select count(*)::int as count from location_closure_days`;
        const dates = await tx<{ count: number }[]>`select count(*)::int as count from employee_date_availability`;
        return { closures: closures[0]!.count, dates: dates[0]!.count };
      });
      expect(asOwnTenant.closures).toBeGreaterThan(0);
      expect(asOwnTenant.dates).toBeGreaterThan(0);
    });

    it("refuses a cross-tenant insert through the policy's with check", async () => {
      const write = (statement: (tx: Database) => Promise<unknown>) => db.begin(async (tx) => {
        await tx.unsafe(`set local role ${probeRole}`);
        await tx`select set_config('app.business_id',${foreignBusinessId},true)`;
        await statement(tx as unknown as Database);
      });
      await expect(write((tx) => tx`
        insert into location_closure_days(business_id,location_id,local_date)
        values (${businessId},${locationId},'2034-02-02')
      `)).rejects.toThrow(/row-level security/i);
      await expect(write((tx) => tx`
        insert into employee_date_availability(business_id,employee_id,local_date,working)
        values (${businessId},${employeeA},'2034-02-02',false)
      `)).rejects.toThrow(/row-level security/i);
      const [leaked] = await db<{ count: number }[]>`
        select count(*)::int as count from location_closure_days
        where business_id=${businessId} and local_date='2034-02-02'
      `;
      expect(leaked?.count).toBe(0);
    });
  });

  describe("the stored shape of the new tables", () => {
    it("refuses a working day with no window and a day off that carries one", async () => {
      await expect(db`
        insert into employee_date_availability(business_id,employee_id,local_date,working)
        values (${businessId},${employeeA},'2034-03-03',true)
      `).rejects.toThrow();
      await expect(db`
        insert into employee_date_availability(business_id,employee_id,local_date,working,start_time,end_time)
        values (${businessId},${employeeA},'2034-03-03',false,'09:00','17:00')
      `).rejects.toThrow();
      await expect(db`
        insert into employee_date_availability(business_id,employee_id,local_date,working,start_time,end_time)
        values (${businessId},${employeeA},'2034-03-03',true,'17:00','09:00')
      `).rejects.toThrow();
    });

    it("allows one row per groomer per date and one closure per location per date", async () => {
      await db`
        insert into employee_date_availability(business_id,employee_id,local_date,working)
        values (${businessId},${employeeA},'2034-04-04',false)
      `;
      await expect(db`
        insert into employee_date_availability(business_id,employee_id,local_date,working)
        values (${businessId},${employeeA},'2034-04-04',false)
      `).rejects.toThrow();
      await db`
        insert into location_closure_days(business_id,location_id,local_date)
        values (${businessId},${locationId},'2034-04-04')
      `;
      await expect(db`
        insert into location_closure_days(business_id,location_id,local_date)
        values (${businessId},${locationId},'2034-04-04')
      `).rejects.toThrow();
    });

    it("holds the appointment limit to the range the API will accept", async () => {
      await expect(db`
        insert into employee_date_availability(business_id,employee_id,local_date,working,start_time,end_time,appointment_limit)
        values (${businessId},${employeeA},'2034-05-05',true,'09:00','17:00',0)
      `).rejects.toThrow();
      await expect(db`
        update employee_working_hours set appointment_limit=11
        where business_id=${businessId} and employee_id=${employeeA}
      `).rejects.toThrow();
    });
  });
});
