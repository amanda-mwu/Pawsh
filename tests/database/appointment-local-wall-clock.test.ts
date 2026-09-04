import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * The denormalised local wall clock, and the instant it is derived from.
 *
 * `appointments.scheduled_local_start` and the `blocked_times` pair are `timestamp without time
 * zone`: the salon's wall clock, stored beside the authoritative `timestamptz` so the calendar
 * can range-scan a local date. The write paths used to bind the operator's own local string into
 * those columns, and postgres.js serialises anything bound to a 1082/1114/1184 parameter through
 * `new Date(x).toISOString()` - which reads a zone-less string in the API HOST's timezone. On a
 * Pacific host a 12:30 booking was persisted as 19:30.
 *
 * WHY NO EXISTING TEST CAUGHT IT, AND WHAT THAT DICTATES ABOUT THESE ONES. The corruption is a
 * no-op when the host runs in UTC, `start_at` was never wrong, and every surface a person looks
 * at derives from `start_at` - so the UI stayed correct while the row rotted underneath it. A
 * suite that asserts rendered times therefore proves nothing here. Everything below reads the
 * STORED value through `to_char`, so the assertion is a string comparison the driver cannot
 * reinterpret and the result does not depend on the machine the suite runs on.
 *
 * The `Intl`-based helpers in `src/domain/time.ts` were never the problem and are not retested
 * here; `tests/unit/wall-time.test.ts` owns them. What is new is the boundary between a resolved
 * instant and the row it is written to.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "appointment-local-wall-clock-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

/** The salon's zone. `locations.timezone` defaults to it, so this is the out-of-the-box case. */
const ZONE = "America/Los_Angeles";

describeDatabase("appointment local wall clock", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  let ownerCookie = "";
  let businessId = "";
  let locationId = "";
  let employeeId = "";
  let serviceId = "";
  let customerId = "";
  let petId = "";

  /**
   * The stored row, read as text.
   *
   * `to_char` on both columns rather than letting the driver hand back `Date` objects: a naive
   * column comes back through `new Date(x)`, which would fold the host's timezone into the
   * assertion and hide exactly the defect being tested.
   */
  const storedAppointment = async (id: string) => {
    const [row] = await db<{
      startAt: string; endAt: string; localStart: string; offsetMinutes: number;
      timeZone: string; disambiguation: string | null; localStartFromInstant: string;
    }[]>`
      select to_char(start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as start_at,
        to_char(end_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as end_at,
        to_char(scheduled_local_start,'YYYY-MM-DD"T"HH24:MI') as local_start,
        scheduled_utc_offset_minutes as offset_minutes,
        scheduling_timezone as time_zone,
        scheduled_disambiguation as disambiguation,
        to_char(start_at at time zone scheduling_timezone,'YYYY-MM-DD"T"HH24:MI')
          as local_start_from_instant
      from appointments where business_id=${businessId} and id=${id}
    `;
    return row!;
  };

  const book = (localStart: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId, serviceIds: [serviceId],
        localStart, expectedLocationVersion: 1,
        // The suite books outside staff hours on purpose - 01:30 in the repeated hour is the
        // whole point of one case - so availability is overridden rather than seeded around.
        availabilityOverride: true, overrideReason: "Wall-clock regression fixture",
        ...extra
      }
    });

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const ownerEmail = `wallclock-owner-${suffix}@example.test`;
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: ownerEmail, password: "correct horse wall clock battery",
        businessName: "Wall Clock Salon"
      }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());

    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
    serviceId = (await post("/api/services", {
      name: "Wall Clock Groom", baseDurationMinutes: 60, basePriceMinor: 7200
    })).json().id;
    employeeId = (await post("/api/employees", {
      displayName: "Wall Clock Groomer", serviceIds: [serviceId]
    })).json().id;
    customerId = (await post("/api/customers", {
      firstName: "Wall", lastName: "Clock", phone: "555-0199"
    })).json().id;
    petId = (await post("/api/pets", {
      customerId, name: "Wall Clock Pet", species: "dog", breed: "Poodle"
    })).json().id;

    const [location] = await db<{ timezone: string }[]>`
      select timezone from locations where business_id=${businessId} and id=${locationId}
    `;
    // Everything below is written for a NON-UTC salon; if the default ever changed, the exact
    // instants asserted here would be wrong in a way that reads as a product bug.
    expect(location!.timezone).toBe(ZONE);
  }, 30_000);

  afterAll(async () => { await app.close(); await db.end(); });

  /**
   * The four cases a Pacific salon can present, each with the instant written out in full.
   *
   * Standard time and daylight time differ by an hour of offset, which is the difference the old
   * code got wrong by seven. The two November rows are the SAME wall clock resolving to two
   * different instants - the repeated hour - and they are here because they are the reason the
   * database constraint is written as "instant -> wall clock" and never the reverse: converting
   * 01:30 back would pick one instant, and whichever one Postgres picked, the other booking is
   * legitimate and would be refused.
   */
  const cases = [
    { label: "standard time", localStart: "2027-01-20T09:30", extra: {},
      instant: "2027-01-20T17:30:00Z", offsetMinutes: -480, disambiguation: null },
    { label: "daylight time", localStart: "2027-07-14T09:30", extra: {},
      instant: "2027-07-14T16:30:00Z", offsetMinutes: -420, disambiguation: null },
    { label: "the day the clocks go forward", localStart: "2027-03-14T09:30", extra: {},
      instant: "2027-03-14T16:30:00Z", offsetMinutes: -420, disambiguation: null },
    { label: "the repeated hour, earlier instant", localStart: "2027-11-07T01:30",
      extra: { disambiguation: "earlier" },
      instant: "2027-11-07T08:30:00Z", offsetMinutes: -420, disambiguation: "earlier" },
    { label: "the repeated hour, later instant", localStart: "2027-11-07T01:30",
      extra: { disambiguation: "later" },
      instant: "2027-11-07T09:30:00Z", offsetMinutes: -480, disambiguation: "later" }
  ] as const;

  for (const scenario of cases) {
    it(`persists the booked wall clock and the exact instant - ${scenario.label}`, async () => {
      const created = await book(scenario.localStart, scenario.extra);
      expect(created.statusCode, created.body).toBe(201);

      const row = await storedAppointment(created.json().id);
      // The instant is the authority and is stated exactly, not derived from the same helper the
      // route used - otherwise the assertion would agree with the code by construction.
      expect(row.startAt).toBe(scenario.instant);
      expect(row.timeZone).toBe(ZONE);
      expect(row.offsetMinutes).toBe(scenario.offsetMinutes);
      expect(row.disambiguation).toBe(scenario.disambiguation);
      // The stored wall clock is the booked wall clock, on every host.
      expect(row.localStart).toBe(scenario.localStart);
      // ...and it agrees with what the instant converts to, which is the invariant the schema
      // now enforces and the calendar's local-date range scan depends on.
      expect(row.localStart).toBe(row.localStartFromInstant);

      // The API states the same wall clock the booking asked for, in the same shape, from both
      // the write response and the read projection. Before the read fix these disagreed: the
      // create response answered "2027-01-20T09:30" while the projection handed back the naive
      // column as an INSTANT ("2027-01-20T09:30:00.000Z" on a UTC host and something else
      // everywhere else), and the mobile client reads this field as a wall clock.
      expect(created.json().scheduledLocalStart).toBe(scenario.localStart);
      const read = await app.inject({
        method: "GET", url: `/api/appointments/${created.json().id}`,
        headers: { cookie: ownerCookie }
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().scheduledLocalStart).toBe(scenario.localStart);
    });
  }

  it("keeps the wall clock and the instant together across a reschedule", async () => {
    const created = await book("2027-02-10T11:00");
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;

    // Standard time to daylight time, so a move that gets the offset wrong cannot pass by
    // landing on the same number.
    const moved = await app.inject({
      method: "PATCH", url: `/api/appointments/${id}/schedule`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        employeeId, localStart: "2027-06-09T14:45", expectedLocationVersion: 1,
        version: created.json().version,
        availabilityOverride: true, overrideReason: "Wall-clock regression fixture"
      }
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const row = await storedAppointment(id);
    expect(row.startAt).toBe("2027-06-09T21:45:00Z");
    expect(row.localStart).toBe("2027-06-09T14:45");
    expect(row.localStart).toBe(row.localStartFromInstant);
    expect(row.offsetMinutes).toBe(-420);
    expect(moved.json().scheduledLocalStart).toBe("2027-06-09T14:45");
  });

  it("leaves the wall clock alone while the visit moves through its lifecycle", async () => {
    const created = await book("2027-04-21T10:15");
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const before = await storedAppointment(id);

    for (const status of ["checked_in", "in_service", "completed"]) {
      const response = await app.inject({
        method: "POST", url: `/api/appointments/${id}/transition`,
        headers: { cookie: ownerCookie }, payload: { status }
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    const after = await storedAppointment(id);
    expect(after.localStart).toBe(before.localStart);
    expect(after.startAt).toBe(before.startAt);
    expect(after.localStart).toBe(after.localStartFromInstant);

    // The lifecycle columns are `timestamptz` and are stamped from the server clock, so they
    // carry no wall-clock ambiguity of their own. What is asserted is that they are real
    // instants either side of now rather than values that drifted through a host offset - a
    // seven-hour error here would put a check-in hours into the future.
    const [times] = await db<{ checkedInAt: Date; checkedOutAt: Date }[]>`
      select checked_in_at,checked_out_at from appointments
      where business_id=${businessId} and id=${id}
    `;
    const now = Date.now();
    expect(times!.checkedInAt.getTime()).toBeLessThanOrEqual(now);
    expect(times!.checkedInAt.getTime()).toBeGreaterThan(now - 10 * 60_000);
    expect(times!.checkedOutAt.getTime()).toBeGreaterThanOrEqual(times!.checkedInAt.getTime());
    expect(times!.checkedOutAt.getTime()).toBeLessThanOrEqual(now + 10 * 60_000);
  });

  it("persists a blocked time's local window from its instants", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/blocked-times",
      headers: { cookie: ownerCookie },
      payload: {
        employeeId, locationId, localStart: "2027-08-18T13:00", localEnd: "2027-08-18T15:30",
        expectedLocationVersion: 1, reason: "Wall-clock regression fixture"
      }
    });
    expect(created.statusCode, created.body).toBe(201);

    const [row] = await db<{
      startAt: string; endAt: string; localStart: string; localEnd: string;
    }[]>`
      select to_char(start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as start_at,
        to_char(end_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as end_at,
        to_char(scheduled_local_start,'YYYY-MM-DD"T"HH24:MI') as local_start,
        to_char(scheduled_local_end,'YYYY-MM-DD"T"HH24:MI') as local_end
      from blocked_times where business_id=${businessId} and id=${created.json().id}
    `;
    expect(row!.startAt).toBe("2027-08-18T20:00:00Z");
    expect(row!.endAt).toBe("2027-08-18T22:30:00Z");
    expect(row!.localStart).toBe("2027-08-18T13:00");
    expect(row!.localEnd).toBe("2027-08-18T15:30");
  });

  /**
   * The guarantee, rather than one more example of it.
   *
   * The two tests below go around the routes on purpose. Every assertion above proves that the
   * write paths that exist today are correct; these prove that a write path that is WRONG cannot
   * land, which is the property that would have caught this defect the first time it happened
   * instead of two features later.
   */
  it("refuses a row whose stored wall clock disagrees with its instant", async () => {
    const created = await book("2027-09-15T12:30");
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;

    await expect(db`
      update appointments set scheduled_local_start = scheduled_local_start + interval '7 hours'
      where business_id=${businessId} and id=${id}
    `).rejects.toThrow(/appointment_local_start_matches_instant/);

    // Moving the instant without the wall clock is the same failure from the other side.
    await expect(db`
      update appointments set start_at = start_at + interval '1 hour'
      where business_id=${businessId} and id=${id}
    `).rejects.toThrow(/appointment_local_start_matches_instant/);

    // And the row is untouched, because a check constraint aborts the statement.
    expect((await storedAppointment(id)).localStart).toBe("2027-09-15T12:30");
  });

  it("refuses a blocked time whose stored window disagrees with its instants", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/blocked-times",
      headers: { cookie: ownerCookie },
      payload: {
        employeeId, locationId, localStart: "2027-08-19T13:00", localEnd: "2027-08-19T15:30",
        expectedLocationVersion: 1, reason: "Wall-clock regression fixture"
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    await expect(db`
      update blocked_times set scheduled_local_end = scheduled_local_end + interval '7 hours'
      where business_id=${businessId} and id=${created.json().id}
    `).rejects.toThrow(/blocked_time_local_window_matches_instants/);
  });

  /**
   * The hazard itself, named so it cannot be "simplified" back in.
   *
   * This is the mechanism the whole suite exists for: postgres.js keys its serializers on the
   * parameter type the SERVER describes, and the date serializer is registered against all three
   * of `date`, `timestamp` and `timestamptz`. Anything bound to one of those columns therefore
   * goes through `new Date(x)`, and `new Date` reads a zone-less string in the process timezone.
   * A future change that binds `${input.localStart}` straight into a naive column would compile,
   * pass on a UTC CI host, and corrupt every row written on a Pacific one.
   */
  it("documents why a bare local string may never be bound to a timestamp column", async () => {
    const value = "2027-01-20T09:30";
    // One transaction, so the temporary table and both writes stay on a single pooled
    // connection. The driver here is the application's own `createDatabase` handle, not a
    // specially configured one, because the claim under test is about how Pawsh talks to
    // Postgres and not about how postgres.js can be made to behave.
    const { bound, castFirst } = await db.begin(async (tx) => {
      await tx`create temporary table wall_clock_probe (bound timestamp, cast_first timestamp)`;
      await tx`
        insert into wall_clock_probe (bound, cast_first)
        values (${value}, (${value}::text)::timestamp)
      `;
      const [row] = await tx<{ bound: string; castFirst: string }[]>`
        select to_char(bound,'YYYY-MM-DD"T"HH24:MI') as bound,
          to_char(cast_first,'YYYY-MM-DD"T"HH24:MI') as cast_first from wall_clock_probe
      `;
      return row!;
    });

    // The guarded form is the identity: `::text` makes the server describe the parameter as
    // text, so the string reaches Postgres unconverted and Postgres parses it.
    expect(castFirst).toBe(value);
    // The bare bind is not. The driver ran it through `new Date(x).toISOString()`, so what
    // landed in the column is the UTC clock of a local time read on THIS host.
    expect(bound).toBe(new Date(value).toISOString().slice(0, 16));
    // Which is the same thing exactly when the host is UTC - stated as an equivalence so the
    // test asserts the rule on every machine rather than a Pacific offset only Pacific machines
    // have, and so it fails if a future driver upgrade changes the hazard in either direction.
    expect(bound === castFirst).toBe(new Date(value).getTimezoneOffset() === 0);
  });
});
