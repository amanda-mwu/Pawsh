import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * The six-step availability contract, exercised through the routes that book appointments.
 *
 * WHY THIS SUITE EXISTS. `src/domain/availability.ts` has stated the precedence between the five
 * things that can restrict a groomer's day since 0027, and `tests/domain/availability.test.ts`
 * has pinned every ordering pair in it. Booking did not use any of it. It ran a single SQL
 * predicate that never read `employee_date_availability` at all, so step 2 - the step 0027
 * asserts as a rule of the schema - was enforced nowhere, and the four refusals below could not
 * be told apart from one another or from a generic 400.
 *
 * So the domain tests prove the rules are right and this suite proves the PRODUCT OBEYS THEM. It
 * tests the precedence as a whole rather than helper by helper: every case here goes in through
 * `POST /api/appointments` or `PATCH /api/appointments/:id/schedule` and comes back as a status
 * code, a wire code and a row that is or is not in the table.
 *
 * NO OPERATOR CRUD EXISTS FOR `employee_date_availability`. There is no route and no screen that
 * writes it, which is why every fixture below inserts the row directly. That is a real gap and it
 * is reported as one; it is not a reason for scheduling to ignore the table, because a row that
 * arrives by any means at all must be honoured, and because the table is what the contract is
 * written about.
 *
 * DATES. All in America/Los_Angeles, chosen so each half of the year and each transition is
 * covered by a date that is not near any other case:
 *
 *   2027-01-12  PST, an ordinary winter Tuesday
 *   2027-07-13  PDT, an ordinary summer Tuesday
 *   2027-03-14  spring forward, 02:00 -> 03:00, a 23-hour day
 *   2027-11-07  fall back, 02:00 -> 01:00, a 25-hour day with a repeated 01:00 hour
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "staff-date-availability-secret-32-characters",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const sessionCookie = (response: { headers: Record<string, unknown> }) => {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
};

const PST_DAY = "2027-01-12";
const PDT_DAY = "2027-07-13";
const SPRING_FORWARD = "2027-03-14";
const FALL_BACK = "2027-11-07";

describeDatabase("staff availability precedence, through the booking routes", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string;
  let businessId: string, locationId: string, customerId: string, petId: string;
  let serviceId: string, employeeId: string;
  const suffix = crypto.randomUUID().slice(0, 8);

  const locationVersion = async () => {
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } });
    return me.json().business.locationVersion as number;
  };

  const book = async (localStart: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId, serviceIds: [serviceId],
        localStart, expectedLocationVersion: await locationVersion(), ...extra
      }
    });

  const move = async (id: string, localStart: string, version: number, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "PATCH", url: `/api/appointments/${id}/schedule`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { employeeId, localStart, version, expectedLocationVersion: await locationVersion(), ...extra }
    });

  /** How many appointments this groomer holds on one LOCAL date, read from the instant. */
  const bookedOn = async (localDate: string) => {
    const [row] = await db<{ count: number }[]>`
      select count(*)::int as count from appointments
      where business_id=${businessId} and employee_id=${employeeId}
        and (start_at at time zone scheduling_timezone)::date=${localDate}::date
    `;
    return row!.count;
  };

  /** No route writes this table; the contract is about the row, not about how it got there. */
  const setDateAvailability = async (
    localDate: string,
    row: { working: boolean; startTime?: string; endTime?: string }
  ) => {
    await db`
      delete from employee_date_availability
      where business_id=${businessId} and employee_id=${employeeId} and local_date=${localDate}::date
    `;
    await db`
      insert into employee_date_availability
        (business_id,employee_id,local_date,working,start_time,end_time)
      values (${businessId},${employeeId},${localDate}::date,${row.working},
        ${row.startTime ?? null},${row.endTime ?? null})
    `;
  };

  const clearDateAvailability = async (localDate: string) => db`
    delete from employee_date_availability
    where business_id=${businessId} and employee_id=${employeeId} and local_date=${localDate}::date
  `;

  const blockTime = async (
    localStart: string, localEnd: string, extra: Record<string, unknown> = {}
  ) => app.inject({
    method: "POST", url: "/api/blocked-times", headers: { cookie: ownerCookie },
    payload: {
      employeeId, locationId, localStart, localEnd, reason: "Fixture block",
      expectedLocationVersion: await locationVersion(), ...extra
    }
  });

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `date-availability-${suffix}@example.test`,
      password: "correct horse date availability", businessName: `Date Availability Salon ${suffix}`
    }});
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = sessionCookie(signup);
    ({ businessId, locationId } = signup.json());
    await db`update locations set timezone='America/Los_Angeles' where id=${locationId}`;

    serviceId = (await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name: `Date Groom ${suffix}`, baseDurationMinutes: 60, basePriceMinor: 7000 }
    })).json().id;
    employeeId = (await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: `Dana Date ${suffix}`, serviceIds: [serviceId] }
    })).json().id;
    customerId = (await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName: "Date", lastName: "Client", preferredContactMethod: "none", emailAllowed: false }
    })).json().id;
    petId = (await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Date Pet", species: "dog" }
    })).json().id;

    // Nine to five on every weekday, so a fixture date never has to care which day it lands on and
    // the groomer is never accidentally in the unrestricted fail-open branch.
    for (let weekday = 0; weekday < 7; weekday += 1) {
      await db`
        insert into employee_working_hours(business_id,employee_id,weekday,start_time,end_time)
        values (${businessId},${employeeId},${weekday},'09:00','17:00')
      `;
    }
    // The location deliberately keeps NO `business_hours` rows for most of this suite. That is the
    // fail-open branch a live location actually sits in, and the one test that needs a bound adds
    // rows and takes them away again.
  });
  afterAll(async () => { await app.close(); await db.end(); });

  describe("3. the weekday default, which is what a workspace with no per-date rows has", () => {
    it("books inside the groomer's hours and refuses outside them, by name", async () => {
      expect((await book(`${PST_DAY}T10:00`)).statusCode).toBe(201);
      const refused = await book(`${PST_DAY}T20:00`);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({
        code: "OUTSIDE_STAFF_HOURS", employeeId, localDate: PST_DAY, canOverride: true
      });
      // The message names the groomer and the date, because "outside availability" named neither.
      expect(refused.json().error).toContain(`does not work at that time on ${PST_DAY}`);
    });

    it("refuses a weekday the groomer does not work at all", async () => {
      await db`
        delete from employee_working_hours
        where business_id=${businessId} and employee_id=${employeeId} and weekday=3
      `;
      // 2027-01-13 is the Wednesday after the PST fixture date.
      const refused = await book("2027-01-13T10:00");
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe("OUTSIDE_STAFF_HOURS");
      await db`
        insert into employee_working_hours(business_id,employee_id,weekday,start_time,end_time)
        values (${businessId},${employeeId},3,'09:00','17:00')
      `;
      expect((await book("2027-01-13T10:00")).statusCode).toBe(201);
    });
  });

  describe("2. a per-date row REPLACES the weekday default", () => {
    const day = "2027-01-19";

    it("books inside the override's window even though the weekday row does not reach it", async () => {
      await setDateAvailability(day, { working: true, startTime: "18:00", endTime: "22:00" });
      // 19:00 is outside 09:00-17:00 and inside 18:00-22:00. A MERGE would have had to consult
      // both; a replacement consults only the override, which is the contract.
      const created = await book(`${day}T19:00`);
      expect(created.statusCode, created.body).toBe(201);
    });

    it("refuses inside the weekday row when the override does not cover it", async () => {
      // The other half of "replaces". 10:00 is inside the weekday default and outside the
      // override, so a merge would have booked it and a replacement must not.
      const refused = await book(`${day}T10:00`);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe("OUTSIDE_STAFF_HOURS");
      await clearDateAvailability(day);
      // And with the row gone the weekday default is back, unchanged by any of this.
      expect((await book(`${day}T10:00`)).statusCode).toBe(201);
    });

    it("refuses the whole date when the row says the groomer is not working", async () => {
      const day2 = "2027-01-26";
      await setDateAvailability(day2, { working: false });
      const refused = await book(`${day2}T10:00`);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({
        code: "STAFF_DATE_UNAVAILABLE", employeeId, localDate: day2
      });
      expect(await bookedOn(day2)).toBe(0);
    });
  });

  describe("1. a location closure is terminal and outranks everything below it", () => {
    const day = "2027-02-02";

    it("beats a per-date row that says the groomer IS working", async () => {
      await setDateAvailability(day, { working: true, startTime: "09:00", endTime: "17:00" });
      expect((await app.inject({
        method: "PUT", url: `/api/locations/${locationId}/closure-days`,
        headers: { cookie: ownerCookie }, payload: { month: "2027-02", closedDates: [day] }
      })).statusCode).toBe(200);
      const refused = await book(`${day}T10:00`);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe("LOCATION_CLOSED");
      expect(await bookedOn(day)).toBe(0);
    });

    it("beats an availability override on top of that", async () => {
      const refused = await book(`${day}T10:00`, {
        availabilityOverride: true, overrideReason: "Owner insists"
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe("LOCATION_CLOSED");
      expect(await bookedOn(day)).toBe(0);
      await clearDateAvailability(day);
    });
  });

  describe("4. the location's business hours bound the day", () => {
    const day = "2027-02-09";

    it("refuses a booking the groomer would take but the salon is shut for", async () => {
      // Written straight to the table rather than through `PUT /api/business/working-hours`, which
      // bumps the location version and would make every other case in this suite read it again.
      // Tuesday only, 11:00-15:00, inside the groomer's 09:00-17:00.
      await db`
        insert into business_hours(business_id,location_id,weekday,start_time,end_time)
        values (${businessId},${locationId},2,'11:00','15:00')
      `;
      const refused = await book(`${day}T09:30`);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: "OUTSIDE_BUSINESS_HOURS", localDate: day });
      expect(refused.json().error).toContain("The salon is not open at that time");
      // Inside both grids still books.
      expect((await book(`${day}T11:30`)).statusCode).toBe(201);
    });

    it("names the groomer's hours first when both grids would refuse", async () => {
      // 20:00 is past the groomer's 17:00 and past the salon's 15:00. Answering "the salon is
      // closed then" would send an operator to edit the wrong grid.
      const refused = await book(`${day}T20:00`);
      expect(refused.json().code).toBe("OUTSIDE_STAFF_HOURS");
      await db`delete from business_hours where business_id=${businessId} and location_id=${locationId}`;
      // With no rows at all the location bounds nothing - the fail-open branch a live location
      // sits in today, and the branch that would silently stop it taking bookings if closed.
      expect((await book(`${day}T09:30`)).statusCode).toBe(201);
    });
  });

  describe("5. blocked times subtract, and a per-date override does not clear them", () => {
    const day = "2027-02-16";

    it("refuses a booking that overlaps a block with its own code", async () => {
      expect((await blockTime(`${day}T13:00`, `${day}T14:00`)).statusCode).toBe(201);
      const refused = await book(`${day}T13:00`);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: "TIME_BLOCKED", localDate: day });
      expect(refused.json().error).toContain("has time blocked out");
      // A booking that merely abuts the block is untouched - the intervals are half-open.
      expect((await book(`${day}T14:00`)).statusCode).toBe(201);
    });

    it("keeps subtracting the block on a date the groomer has a per-date row for", async () => {
      // THE DOCUMENTED TRAP. The override describes the groomer's hours; the block describes time
      // already spoken for. Step 5 subtracts from whatever step 2 produced, exactly as it
      // subtracts from a weekday default.
      const day2 = "2027-02-23";
      expect((await blockTime(`${day2}T13:00`, `${day2}T14:00`)).statusCode).toBe(201);
      await setDateAvailability(day2, { working: true, startTime: "09:00", endTime: "17:00" });
      const refused = await book(`${day2}T13:00`);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe("TIME_BLOCKED");
      await clearDateAvailability(day2);
    });

    it("records the block's own local wall clock alongside its instants", async () => {
      // The naive columns are read as TEXT, never as a Date. A `timestamp without time zone`
      // handed to the driver is parsed in the API HOST's timezone - this machine is Pacific, and
      // the value came back eight hours out when it was first compared as an instant. That is the
      // exact confusion 0051 exists to prevent, so the assertion stays in the column's own frame.
      const [block] = await db<{
        startAt: Date; endAt: Date; schedulingTimezone: string;
        localStart: string; localEnd: string;
      }[]>`
        select start_at,end_at,scheduling_timezone,
          to_char(scheduled_local_start,'YYYY-MM-DD HH24:MI') as local_start,
          to_char(scheduled_local_end,'YYYY-MM-DD HH24:MI') as local_end
        from blocked_times
        where business_id=${businessId} and employee_id=${employeeId}
          and (start_at at time zone scheduling_timezone)::date=${day}::date
      `;
      expect(block!.schedulingTimezone).toBe("America/Los_Angeles");
      // 13:00 PST is 21:00Z; the naive columns hold the LOCAL clock, not the UTC one.
      expect(block!.startAt.toISOString()).toBe(`${day}T21:00:00.000Z`);
      expect(block!.endAt.toISOString()).toBe(`${day}T22:00:00.000Z`);
      expect(block!.localStart).toBe(`${day} 13:00`);
      expect(block!.localEnd).toBe(`${day} 14:00`);
    });
  });

  describe("what an availability override may and may not bypass", () => {
    it("books outside the groomer's ordinary hours, exactly as it always did", async () => {
      const created = await book(`${PDT_DAY}T20:00`, {
        availabilityOverride: true, overrideReason: "Client can only make the evening"
      });
      expect(created.statusCode, created.body).toBe(201);
      const [row] = await db<{ availabilityOverridden: boolean }[]>`
        select availability_overridden from appointments where id=${created.json().id}
      `;
      expect(row!.availabilityOverridden).toBe(true);
    });

    it("bypasses a blocked time and a shut salon, which are ordinary-hours judgements too", async () => {
      const day = "2027-07-20";
      expect((await blockTime(`${day}T13:00`, `${day}T14:00`)).statusCode).toBe(201);
      expect((await book(`${day}T13:00`, {
        availabilityOverride: true, overrideReason: "Squeezing them in"
      })).statusCode).toBe(201);
    });

    // THE RULING. A per-date `working = false` is an explicit statement that this employee is not
    // there on this date. It is not an ordinary-hours restriction, so the override that exists to
    // relax ordinary hours does not reach it, and Pawsh has no capability that does.
    it("is REFUSED against a per-date working = false, and books nothing", async () => {
      const day = "2027-07-27";
      await setDateAvailability(day, { working: false });
      const refused = await book(`${day}T10:00`, {
        availabilityOverride: true, overrideReason: "Owner insists"
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({
        code: "STAFF_DATE_UNAVAILABLE", employeeId, localDate: day, canOverride: false
      });
      expect(refused.json().error).toContain("cannot bypass it");
      expect(await bookedOn(day)).toBe(0);
    });

    it("is refused on RESCHEDULE onto such a date, and leaves the appointment where it was", async () => {
      const from = "2027-08-03", onto = "2027-07-27";
      const created = await book(`${from}T10:00`);
      expect(created.statusCode, created.body).toBe(201);
      const refused = await move(created.json().id, `${onto}T10:00`, created.json().version, {
        availabilityOverride: true, overrideReason: "Move it anyway"
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe("STAFF_DATE_UNAVAILABLE");
      const [row] = await db<{ localDate: string; version: number }[]>`
        select to_char(start_at at time zone scheduling_timezone,'YYYY-MM-DD') as local_date,version
        from appointments where id=${created.json().id}
      `;
      expect(row).toMatchObject({ localDate: from, version: created.json().version });
      await clearDateAvailability(onto);
    });

    it("reports canOverride honestly on the refusals it CAN bypass", async () => {
      const refused = await book(`${PDT_DAY}T21:00`);
      expect(refused.json()).toMatchObject({ code: "OUTSIDE_STAFF_HOURS", canOverride: true });
    });
  });

  describe("daylight saving, in the salon's timezone and never the host's", () => {
    it("keeps a PST booking and a PDT booking on the wall clock that was asked for", async () => {
      // The regression this whole area exists to prevent: the naive columns are DERIVED from the
      // instant in the row's own timezone, so a Pacific host cannot persist 10:00 as 18:00.
      const winter = await book(`${PST_DAY}T14:00`);
      const summer = await book(`${PDT_DAY}T14:00`);
      expect(winter.statusCode, winter.body).toBe(201);
      expect(summer.statusCode, summer.body).toBe(201);
      const stored = async (id: string) => (await db<{
        startAt: Date; endAt: Date; schedulingTimezone: string;
        localStart: string; scheduledUtcOffsetMinutes: number;
      }[]>`
        select start_at,end_at,scheduling_timezone,scheduled_utc_offset_minutes,
          to_char(scheduled_local_start,'YYYY-MM-DD HH24:MI') as local_start
        from appointments where id=${id}
      `)[0]!;

      const w = await stored(winter.json().id);
      expect(w.schedulingTimezone).toBe("America/Los_Angeles");
      expect(w.scheduledUtcOffsetMinutes).toBe(-480);
      expect(w.startAt.toISOString()).toBe(`${PST_DAY}T22:00:00.000Z`);
      expect(w.endAt.toISOString()).toBe(`${PST_DAY}T23:00:00.000Z`);
      expect(w.localStart).toBe(`${PST_DAY} 14:00`);

      const s = await stored(summer.json().id);
      expect(s.schedulingTimezone).toBe("America/Los_Angeles");
      expect(s.scheduledUtcOffsetMinutes).toBe(-420);
      expect(s.startAt.toISOString()).toBe(`${PDT_DAY}T21:00:00.000Z`);
      expect(s.endAt.toISOString()).toBe(`${PDT_DAY}T22:00:00.000Z`);
      expect(s.localStart).toBe(`${PDT_DAY} 14:00`);
    });

    it("books across the spring-forward day on the wall clock, and refuses the hour that never happens", async () => {
      const created = await book(`${SPRING_FORWARD}T10:00`);
      expect(created.statusCode, created.body).toBe(201);
      const [row] = await db<{ startAt: Date; endAt: Date; localStart: string; offset: number }[]>`
        select start_at,end_at,scheduled_utc_offset_minutes as offset,
          to_char(scheduled_local_start,'YYYY-MM-DD HH24:MI') as local_start
        from appointments where id=${created.json().id}
      `;
      // 10:00 on a 23-hour day is still 10:00, and by then the clock has already moved to PDT.
      expect(row!.startAt.toISOString()).toBe(`${SPRING_FORWARD}T17:00:00.000Z`);
      expect(row!.endAt.toISOString()).toBe(`${SPRING_FORWARD}T18:00:00.000Z`);
      expect(row!.localStart).toBe(`${SPRING_FORWARD} 10:00`);
      expect(row!.offset).toBe(-420);
      // 02:30 does not occur on this date at all, and is refused before availability is consulted.
      const nonexistent = await book(`${SPRING_FORWARD}T02:30`);
      expect(nonexistent.statusCode).toBe(400);
      expect(nonexistent.json().code).toBe("NONEXISTENT_LOCAL_TIME");
    });

    it("refuses a per-date working = false across a whole 23-hour and a whole 25-hour day", async () => {
      for (const day of [SPRING_FORWARD, FALL_BACK]) {
        // Measured as a delta rather than as zero: an earlier case in this file books on the
        // spring-forward date on purpose, and the claim here is that NOTHING NEW lands - which is
        // the same claim, and the one that would still hold on a date nothing had touched.
        const before = await bookedOn(day);
        await setDateAvailability(day, { working: false });
        for (const localStart of [`${day}T09:00`, `${day}T12:00`, `${day}T16:00`]) {
          const refused = await book(localStart, {
            availabilityOverride: true, overrideReason: "DST"
          });
          expect(refused.statusCode, `${localStart}: ${refused.body}`).toBe(409);
          expect(refused.json().code, localStart).toBe("STAFF_DATE_UNAVAILABLE");
        }
        expect(await bookedOn(day), day).toBe(before);
        await clearDateAvailability(day);
      }
      // The day after each transition is untouched, so the refusals above are the row and not the
      // date arithmetic swallowing a neighbouring day.
      expect((await book("2027-03-15T10:00")).statusCode).toBe(201);
      expect((await book("2027-11-08T10:00")).statusCode).toBe(201);
    });

    /**
     * THE REPEATED HOUR, AND THE ONE BEHAVIOUR THIS WIRING DELIBERATELY CHANGES.
     *
     * On the fall-back date 01:00-02:00 PDT and 01:00-02:00 PST are two different real hours whose
     * endpoints read as the SAME wall time. The predicate this replaced compared `tstzrange`
     * instants, so a block on the first occurrence did not touch a booking in the second.
     * `dayPeriodForInstants` projects onto the wall clock and, where the wall clock loses time,
     * falls back to the ELAPSED duration - which subtracts both occurrences.
     *
     * That refuses bookings that used to be accepted, on one day a year, and it is the safe
     * direction: the alternative is a block whose wall-clock projection collapses to nothing,
     * handing out an hour a groomer is not there for.
     */
    it("subtracts both occurrences of a blocked repeated hour", async () => {
      // The groomer's ordinary 09:00-17:00 would refuse a 01:30 booking before any block was
      // consulted, so the date gets a per-date window that reaches into the small hours.
      await setDateAvailability(FALL_BACK, { working: true, startTime: "00:00", endTime: "06:00" });
      // ENTIRELY INSIDE THE FIRST OCCURRENCE, which is the whole point: 01:00 to 01:59 PDT is
      // 08:00Z to 08:59Z. Ending at 02:00 instead would have run to 10:00Z and covered both
      // occurrences as instants, and the old predicate would then have refused both bookings below
      // for reasons that had nothing to do with the wall clock.
      const block = await blockTime(`${FALL_BACK}T01:00`, `${FALL_BACK}T01:59`, {
        startDisambiguation: "earlier", endDisambiguation: "earlier"
      });
      expect(block.statusCode, block.body).toBe(201);
      const [stored] = await db<{ startAt: Date; endAt: Date }[]>`
        select start_at,end_at from blocked_times where id=${block.json().id}
      `;
      expect(stored!.startAt.toISOString()).toBe(`${FALL_BACK}T08:00:00.000Z`);
      expect(stored!.endAt.toISOString()).toBe(`${FALL_BACK}T08:59:00.000Z`);

      // "earlier" (08:30Z) overlaps the block as instants and was refused before this change too.
      // "later" (09:30Z) does NOT overlap it as instants - it is the second occurrence of the same
      // wall-clock hour - and is refused only because the projection subtracts both. THAT is the
      // behaviour this wiring changes, which is why it is worth a case of its own.
      for (const disambiguation of ["earlier", "later"] as const) {
        const refused = await book(`${FALL_BACK}T01:30`, { disambiguation });
        expect(refused.statusCode, `${disambiguation}: ${refused.body}`).toBe(409);
        expect(refused.json().code, disambiguation).toBe("TIME_BLOCKED");
      }
      // The rest of the 25-hour day is still bookable, so the over-subtraction is bounded to the
      // repeated hour rather than eating the day.
      expect((await book(`${FALL_BACK}T04:00`)).statusCode).toBe(201);
      await clearDateAvailability(FALL_BACK);
    });
  });

  describe("the whole chain, in one place", () => {
    it("walks a single date down all five restrictions in precedence order", async () => {
      const day = "2027-09-14";
      const attempt = () => book(`${day}T10:00`);
      const codeOf = async () => {
        const response = await attempt();
        return response.statusCode === 201 ? "BOOKED" : response.json().code;
      };

      // 5. A block over the requested hour is the last thing to refuse.
      expect((await blockTime(`${day}T10:00`, `${day}T11:00`)).statusCode).toBe(201);
      expect(await codeOf()).toBe("TIME_BLOCKED");

      // 4. The salon being shut that weekday outranks the block.
      await db`
        insert into business_hours(business_id,location_id,weekday,start_time,end_time)
        values (${businessId},${locationId},1,'09:00','17:00')
      `;
      expect(await codeOf()).toBe("OUTSIDE_BUSINESS_HOURS");

      // 3. The groomer not working that weekday outranks the salon's hours.
      await db`
        delete from employee_working_hours
        where business_id=${businessId} and employee_id=${employeeId} and weekday=2
      `;
      expect(await codeOf()).toBe("OUTSIDE_STAFF_HOURS");

      // 2. An explicit per-date "not working" outranks the weekday grid.
      await setDateAvailability(day, { working: false });
      expect(await codeOf()).toBe("STAFF_DATE_UNAVAILABLE");

      // 1. And a closure outranks all four, including a per-date row that says otherwise.
      await setDateAvailability(day, { working: true, startTime: "09:00", endTime: "17:00" });
      expect((await app.inject({
        method: "PUT", url: `/api/locations/${locationId}/closure-days`,
        headers: { cookie: ownerCookie }, payload: { month: "2027-09", closedDates: [day] }
      })).statusCode).toBe(200);
      expect(await codeOf()).toBe("LOCATION_CLOSED");

      // Nothing was booked at any point on the way down.
      expect(await bookedOn(day)).toBe(0);

      // Unwind, and the same request that was refused five different ways succeeds.
      expect((await app.inject({
        method: "PUT", url: `/api/locations/${locationId}/closure-days`,
        headers: { cookie: ownerCookie }, payload: { month: "2027-09", closedDates: [] }
      })).statusCode).toBe(200);
      await clearDateAvailability(day);
      await db`
        insert into employee_working_hours(business_id,employee_id,weekday,start_time,end_time)
        values (${businessId},${employeeId},2,'09:00','17:00')
      `;
      await db`delete from business_hours where business_id=${businessId} and location_id=${locationId}`;
      await db`
        delete from blocked_times where business_id=${businessId} and employee_id=${employeeId}
          and (start_at at time zone scheduling_timezone)::date=${day}::date
      `;
      expect((await attempt()).statusCode).toBe(201);
    });
  });
});
