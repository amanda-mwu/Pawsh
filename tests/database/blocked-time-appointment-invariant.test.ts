import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * THE BLOCK/APPOINTMENT INVARIANT, CLOSED IN BOTH DIRECTIONS.
 *
 * Pawsh has refused a booking that lands on a blocked time since the calendar existed, and hard -
 * `TIME_BLOCKED`, `canOverride: false` - since seam 2a. It did not refuse the mirror: a block laid
 * straight over a booked appointment was written without so much as a read of `appointments`. So
 * the state the booking path exists to prevent was reachable by walking up to it from the other
 * side, and once reached, the calendar drew a groomer as simultaneously unavailable and booked
 * while the availability authority refused every further booking that touched the window. Nothing
 * in the product could say which of the two was the truth.
 *
 * The guard lands on `POST` and `PATCH` together, because on either alone it would be worthless:
 * a `POST`-only guard is walked around by creating the block clear and moving it, and a
 * `PATCH`-only guard is walked around by creating it on top in the first place.
 *
 * FOUR THINGS HERE ARE EASY TO GET QUIETLY WRONG AND ARE PINNED SEPARATELY.
 *
 * 1. THE OCCUPANCY DEFINITION. Which appointments occupy a groomer's time is
 *    `status in ('scheduled','checked_in','in_service')`, joined through `appointment_employees`,
 *    overlapping on half-open `tstzrange(...,'[)')`. That is the scheduling authority's own
 *    definition and this route reuses the authority's own function rather than restating it, so
 *    the two directions of one invariant cannot drift apart. The boundary cases below are what
 *    would catch a restatement: touching is not overlapping, and a cancelled or completed visit
 *    does not occupy anything.
 *
 * 2. THE LOCK. A read-then-write outside `lockSchedulingResources` is not a guard at all - a
 *    booking committed between the read and the write walks straight through it. The concurrency
 *    cases hold two real transactions at a barrier and release them into each other; run them
 *    sequentially and they prove nothing.
 *
 * 3. THE ORDER AGAINST THE VERSION CHECK. `version` and the scheduling lock answer different
 *    questions and a request can fail both. The order is a decision and is asserted as one.
 *
 * 4. NON-BYPASSABILITY. There is no flag, and adding one later has to break a test.
 *
 * 5. THE TOLERANCE. The rule is no longer "no overlap at all": a block and an appointment may
 *    intersect by up to `BLOCKED_TIME_TOLERANCE_MINUTES` (fifteen), measured as the length of the
 *    intersection, per block, in BOTH directions - a block laid over a booking and a booking laid
 *    over a block - and past that it is refused exactly as it always was. The boundary cases in
 *    "where the boundary is" therefore overlap by thirty minutes or more, and the tolerance has a
 *    describe of its own that walks both edges at 0, 5, 15, 16 and 60. The closing sweep counts
 *    intersections PAST the tolerance, because tolerated ones are supposed to exist by then.
 *
 * EVERY TIME HERE IS AMERICA/LOS_ANGELES, and the cases alternate between February (PST, UTC-8)
 * and July (PDT, UTC-7), following every Block Time seam before this one. A UTC salon cannot fail
 * a wall-clock case at all, and a fixed-offset implementation passes one half of the year.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "blocked-time-invariant-secret-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const sessionCookie = (response: { headers: Record<string, unknown> }) => {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
};

interface BlockRow {
  id: string; employeeId: string; version: number;
  startAt: string; endAt: string;
  scheduledLocalStart: string; scheduledLocalEnd: string;
}

interface ConflictBody {
  code: string; error: string; canOverride: boolean;
  conflicts: { appointmentId: string; startsAt: string; endsAt: string }[];
}

describeDatabase("a blocked time may not cover a booked appointment", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string;
  let businessId: string, locationId: string, secondLocationId: string;
  let employeeId: string, employeeName: string;
  let otherEmployeeId: string;
  let customerId: string, petId: string, serviceId: string;
  let rivalCookie: string, rivalLocationId: string, rivalEmployeeId: string;
  let rivalCustomerId: string, rivalPetId: string, rivalServiceId: string;

  const suffix = crypto.randomUUID().slice(0, 8);

  /**
   * A BARRIER ACROSS EVERY SCHEDULING MUTATION, WHICH IS WHAT MAKES THE RACES REAL.
   *
   * `schedulingHooks.beforeLock` fires immediately before `lockSchedulingResources` on all four
   * operations that take it - booking, rescheduling, and now creating and moving a block. Both
   * requests are held there until both have arrived, so neither can have finished its guard before
   * the other started: they are released into a genuine contest for the same advisory lock, and
   * which one wins is decided by postgres rather than by the order the test happened to await in.
   *
   * Without this the two `app.inject` promises would almost always serialise and every case below
   * would pass against a guard with no lock at all.
   */
  let barrier: { expected: number; arrived: number; release: () => void; promise: Promise<void> } | null = null;
  function armBarrier(expected = 2): void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => { release = resolve; });
    barrier = { expected, arrived: 0, release, promise };
  }

  /**
   * PST in February, PDT in July, and one fresh local day per case.
   *
   * Blocks and appointments both persist for the life of the suite, and a case that reused a day
   * would be deciding its own outcome with the leftovers of the last one - an "allowed" block from
   * an earlier case refusing a later case's booking, and the failure reading as this seam's bug.
   * Alternating the two months means the suite as a whole exercises both offsets rather than
   * choosing one.
   */
  let dayIndex = 0;
  const nextDay = (): string => {
    const index = dayIndex;
    dayIndex += 1;
    const day = String(1 + Math.floor(index / 2)).padStart(2, "0");
    return index % 2 === 0 ? `2029-02-${day}` : `2029-07-${day}`;
  };

  const locationVersion = async (id: string) => {
    const [row] = await db<{ version: number }[]>`select version from locations where id=${id}`;
    return row!.version;
  };

  const blockTime = async (input: {
    localStart: string; localEnd: string; employeeId?: string; locationId?: string;
    extra?: Record<string, unknown>;
  }) => {
    const target = input.locationId ?? locationId;
    return app.inject({
      method: "POST", url: "/api/blocked-times", headers: { cookie: ownerCookie },
      payload: {
        employeeId: input.employeeId ?? employeeId, locationId: target,
        localStart: input.localStart, localEnd: input.localEnd,
        reason: "Invariant fixture", expectedLocationVersion: await locationVersion(target),
        ...input.extra
      }
    });
  };

  const created = async (input: Parameters<typeof blockTime>[0]): Promise<BlockRow> => {
    const response = await blockTime(input);
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as BlockRow;
  };

  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH", url: `/api/blocked-times/${id}`,
      headers: { cookie: ownerCookie }, payload
    });

  /** Moving a block, with the four schedule fields the update schema requires together. */
  const movePayload = async (input: {
    version: number; localStart: string; localEnd: string; employeeId?: string;
  }) => ({
    version: input.version,
    employeeId: input.employeeId ?? employeeId,
    localStart: input.localStart, localEnd: input.localEnd,
    expectedLocationVersion: await locationVersion(locationId)
  });

  const book = async (localStart: string, staffId = employeeId) =>
    app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId: staffId, serviceIds: [serviceId],
        localStart, expectedLocationVersion: await locationVersion(locationId)
      }
    });

  /** A booked appointment on the given wall clock, one hour long, and its id. */
  const booked = async (localStart: string, staffId = employeeId) => {
    const response = await book(localStart, staffId);
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; version: number };
  };

  const move = (appointmentId: string, payload: { localStart: string; version: number; employeeId?: string }) =>
    app.inject({
      method: "PATCH", url: `/api/appointments/${appointmentId}/schedule`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        employeeId: payload.employeeId ?? employeeId,
        localStart: payload.localStart, version: payload.version, expectedLocationVersion: 1
      }
    });

  const transition = (appointmentId: string, status: string) =>
    app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/transition`,
      headers: { cookie: ownerCookie }, payload: { status, reason: "Fixture" }
    });

  /**
   * THE INVARIANT ITSELF, ASKED OF THE DATABASE RATHER THAN OF A ROUTE.
   *
   * Every case that lets one of two racers through checks this afterwards, because "one request
   * got a 409" and "no overlap exists" are different claims and only the second one is the
   * invariant. The predicate is the occupancy definition spelled out once, here, in the test's own
   * voice: if production ever narrows or widens its own, this disagrees.
   *
   * `beyondMinutes` is the tolerance, restated in SQL: a block and a booking that intersect by
   * at most that many minutes are allowed to coexist, so the invariant is "no intersection LONGER
   * than the tolerance", and that is what the sweep and the race cases count. Passing 0 counts
   * every intersection, which the sweep also does - to prove the tolerated ones are really there.
   */
  const overlapCount = async (beyondMinutes = 15): Promise<number> => {
    const [row] = await db<{ count: number }[]>`
      select count(*)::int as count
      from blocked_times block
      join appointment_employees assignment
        on assignment.business_id=block.business_id and assignment.employee_id=block.employee_id
      join appointments appointment
        on appointment.business_id=assignment.business_id and appointment.id=assignment.appointment_id
      where block.business_id=${businessId}
        and appointment.status in ('scheduled','checked_in','in_service')
        and tstzrange(block.start_at,block.end_at,'[)')
            && tstzrange(appointment.start_at,appointment.end_at,'[)')
        and least(block.end_at,appointment.end_at) - greatest(block.start_at,appointment.start_at)
            > make_interval(mins => ${beyondMinutes})
    `;
    return row!.count;
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, {
      runWorker: false, serveStatic: false,
      schedulingHooks: {
        async beforeLock() {
          if (!barrier) return;
          const active = barrier;
          active.arrived += 1;
          if (active.arrived === active.expected) {
            barrier = null;
            active.release();
          }
          await active.promise;
        }
      }
    });
    await app.ready();

    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `block-invariant-${suffix}@example.test`,
      password: "correct horse blocked invariant", businessName: `Block Invariant ${suffix}`
    }});
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = sessionCookie(signup);
    ({ businessId, locationId } = signup.json());
    // Set in SQL, which does not move the location version, and before any version is read.
    await db`update locations set timezone='America/Los_Angeles' where id=${locationId}`;

    // A SECOND SHOP IN THE SAME BUSINESS. A groomer is a person, not a room, so a block filed at
    // one shop and a booking taken at another are still the same hour of the same person's day.
    // This exists so that claim is asserted rather than assumed.
    const [second] = await db<{ id: string }[]>`
      insert into locations(business_id,name,address,timezone)
      values (${businessId},'Second Shop','8 Second Street','America/Los_Angeles') returning id
    `;
    secondLocationId = second!.id;

    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
    serviceId = (await post("/api/services", {
      name: `Invariant Groom ${suffix}`, baseDurationMinutes: 60, basePriceMinor: 7000
    })).json().id;
    employeeName = `Ida Invariant ${suffix}`;
    employeeId = (await post("/api/employees", {
      displayName: employeeName, serviceIds: [serviceId]
    })).json().id;
    otherEmployeeId = (await post("/api/employees", {
      displayName: `Otto Other ${suffix}`, serviceIds: [serviceId]
    })).json().id;
    customerId = (await post("/api/customers", {
      firstName: "Invariant", lastName: "Client",
      preferredContactMethod: "none", emailAllowed: false
    })).json().id;
    petId = (await post("/api/pets", {
      customerId, name: "Invariant Pet", species: "dog"
    })).json().id;

    // Nine to five every weekday for both groomers, so no fixture date lands in the unconfigured
    // fail-open branch and a refusal is never ambiguous about which step produced it.
    for (const staffId of [employeeId, otherEmployeeId]) {
      for (let weekday = 0; weekday < 7; weekday += 1) {
        await db`
          insert into employee_working_hours(business_id,employee_id,weekday,start_time,end_time)
          values (${businessId},${staffId},${weekday},'09:00','17:00')
        `;
      }
    }

    // A RIVAL TENANT WITH REAL BOOKINGS, so the tenant-scoping cases test a live row rather than
    // an absence. A leak would be invisible to any assertion made against an empty other salon.
    const rival = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `block-invariant-rival-${suffix}@example.test`,
      password: "correct horse rival invariant", businessName: `Rival Invariant ${suffix}`
    }});
    expect(rival.statusCode, rival.body).toBe(201);
    rivalCookie = sessionCookie(rival);
    rivalLocationId = rival.json().locationId as string;
    const rivalBusinessId = rival.json().businessId as string;
    await db`update locations set timezone='America/Los_Angeles' where id=${rivalLocationId}`;
    const rivalPost = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: rivalCookie }, payload });
    rivalServiceId = (await rivalPost("/api/services", {
      name: `Rival Groom ${suffix}`, baseDurationMinutes: 60, basePriceMinor: 5000
    })).json().id;
    rivalEmployeeId = (await rivalPost("/api/employees", {
      displayName: `Rhea Rival ${suffix}`, serviceIds: [rivalServiceId]
    })).json().id;
    rivalCustomerId = (await rivalPost("/api/customers", {
      firstName: "Rival", lastName: "Client", preferredContactMethod: "none", emailAllowed: false
    })).json().id;
    rivalPetId = (await rivalPost("/api/pets", {
      customerId: rivalCustomerId, name: "Rival Pet", species: "dog"
    })).json().id;
    for (let weekday = 0; weekday < 7; weekday += 1) {
      await db`
        insert into employee_working_hours(business_id,employee_id,weekday,start_time,end_time)
        values (${rivalBusinessId},${rivalEmployeeId},${weekday},'09:00','17:00')
      `;
    }
  }, 90_000);

  const rivalBook = async (localStart: string) => {
    const [version] = await db<{ version: number }[]>`
      select version from locations where id=${rivalLocationId}
    `;
    const response = await app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: rivalCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId: rivalLocationId, customerId: rivalCustomerId, petId: rivalPetId,
        employeeId: rivalEmployeeId, serviceIds: [rivalServiceId],
        localStart, expectedLocationVersion: version!.version
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string };
  };

  afterAll(async () => { await app.close(); await db.end(); });

  // ---------------------------------------------------------------------------------------------
  /**
   * HALF-OPEN `[)`, THE SAME SEMANTICS `findSchedulingConflicts` HAS ALWAYS USED FOR APPOINTMENTS.
   *
   * A block that ends at exactly ten o'clock and an appointment that starts at exactly ten o'clock
   * do not overlap - that is a back-to-back day, not a double booking, and refusing it would make
   * blocking the hour before every appointment impossible. A closed `[]` comparison or a `<=`
   * written by hand fails exactly these two cases and passes every other case in this file, which
   * is why they are first.
   *
   * THE REFUSALS HERE ALL OVERLAP BY THIRTY MINUTES OR MORE, deliberately: they are about the
   * occupancy definition, and a thirty-minute intersection is past the fifteen-minute tolerance
   * whichever way it is measured. The tolerance's own edges are the next describe's.
   */
  describe("where the boundary is", () => {
    it("allows a block that ends exactly when an appointment starts", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const response = await blockTime({ localStart: `${day}T09:00`, localEnd: `${day}T10:00` });
      expect(response.statusCode, response.body).toBe(201);
    });

    it("allows a block that starts exactly when an appointment ends", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const response = await blockTime({ localStart: `${day}T11:00`, localEnd: `${day}T12:00` });
      expect(response.statusCode, response.body).toBe(201);
    });

    it("refuses a block that overlaps the start of an appointment", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const response = await blockTime({ localStart: `${day}T09:30`, localEnd: `${day}T10:30` });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BLOCK_TIME_APPOINTMENT_CONFLICT");
    });

    it("refuses a block that overlaps the end of an appointment", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const response = await blockTime({ localStart: `${day}T10:30`, localEnd: `${day}T11:30` });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BLOCK_TIME_APPOINTMENT_CONFLICT");
    });

    it("refuses a block that wholly contains an appointment", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const response = await blockTime({ localStart: `${day}T09:00`, localEnd: `${day}T13:00` });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BLOCK_TIME_APPOINTMENT_CONFLICT");
    });

    it("refuses a block wholly contained by an appointment", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const response = await blockTime({ localStart: `${day}T10:15`, localEnd: `${day}T10:45` });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BLOCK_TIME_APPOINTMENT_CONFLICT");
    });

    it("allows the same window for a different groomer", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const response = await blockTime({
        localStart: `${day}T10:00`, localEnd: `${day}T11:00`, employeeId: otherEmployeeId
      });
      expect(response.statusCode, response.body).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * THE FIFTEEN-MINUTE TOLERANCE, AT BOTH EDGES, IN BOTH DIRECTIONS, ON EVERY PATH.
   *
   * The quantity is the LENGTH OF THE INTERSECTION - not who started first, not how much of the
   * block or the booking is covered - so the same fifteen minutes is allowed whether the block runs
   * into the start of the booking or the booking runs into the start of the block, and a block that
   * sits wholly inside a booking is measured by its own length. Each block is judged on its own:
   * two blocks clipping one booking by ten minutes each are two permitted intersections. Block
   * against block is never judged at all - Pawsh has no such rule and this describe does not add
   * one.
   *
   * Every fixture appointment is one sixty-minute groom at the wall clock `book` is given.
   */
  describe("the fifteen-minute tolerance", () => {
    const expectBlocked = (response: { statusCode: number; body: string; json: () => any }, code: string) => {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ code, canOverride: false });
    };

    it("allows a block ending 0, 5 or 15 minutes after the appointment starts, and refuses 20 and 60", async () => {
      for (const end of ["10:00", "10:05", "10:15"]) {
        const day = nextDay();
        await booked(`${day}T10:00`);
        const response = await blockTime({ localStart: `${day}T09:00`, localEnd: `${day}T${end}` });
        expect(response.statusCode, `${end}: ${response.body}`).toBe(201);
      }
      // Every scheduled time is on the five-minute grid, so the sixteenth minute cannot be reached
      // by placing a block or a booking - twenty is the first refusal the grid can express. The
      // service-line case below reaches sixteen the one way a length can: a 91-minute duration.
      for (const end of ["10:20", "11:00"]) {
        const day = nextDay();
        await booked(`${day}T10:00`);
        expectBlocked(await blockTime({ localStart: `${day}T09:00`, localEnd: `${day}T${end}` }),
          "BLOCK_TIME_APPOINTMENT_CONFLICT");
      }
    });

    it("allows a block starting 0, 5 or 15 minutes before the appointment ends, and refuses 20 and 60", async () => {
      for (const start of ["11:00", "10:55", "10:45"]) {
        const day = nextDay();
        await booked(`${day}T10:00`);
        const response = await blockTime({ localStart: `${day}T${start}`, localEnd: `${day}T12:00` });
        expect(response.statusCode, `${start}: ${response.body}`).toBe(201);
      }
      for (const start of ["10:40", "10:00"]) {
        const day = nextDay();
        await booked(`${day}T10:00`);
        expectBlocked(await blockTime({ localStart: `${day}T${start}`, localEnd: `${day}T12:00` }),
          "BLOCK_TIME_APPOINTMENT_CONFLICT");
      }
    });

    it("measures a block inside a longer appointment by the block's own length", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      // Fifteen minutes in the middle of the groom: inside the tolerance, however it is placed.
      const short = await blockTime({ localStart: `${day}T10:20`, localEnd: `${day}T10:35` });
      expect(short.statusCode, short.body).toBe(201);
      // Twenty minutes in the middle of the groom: the intersection is the block, and too long.
      const inside = await blockTime({ localStart: `${day}T10:20`, localEnd: `${day}T10:40` });
      expectBlocked(inside, "BLOCK_TIME_APPOINTMENT_CONFLICT");
    });

    it("applies the same tolerance to a block being moved onto a booking", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const block = await created({ localStart: `${day}T13:00`, localEnd: `${day}T14:00` });
      // Ten minutes into the end of the groom: allowed.
      const nudged = await patch(block.id, await movePayload({
        version: block.version, localStart: `${day}T10:50`, localEnd: `${day}T11:50`
      }));
      expect(nudged.statusCode, nudged.body).toBe(200);
      // Twenty minutes in: refused, and the block stays where the allowed move put it.
      const refused = await patch(block.id, await movePayload({
        version: nudged.json().version, localStart: `${day}T10:40`, localEnd: `${day}T11:40`
      }));
      expectBlocked(refused, "BLOCK_TIME_APPOINTMENT_CONFLICT");
      const [stored] = await db<{ version: number; startAt: Date }[]>`
        select version,start_at from blocked_times where id=${block.id}
      `;
      expect(stored!.version).toBe(nudged.json().version);
      expect(stored!.startAt.toISOString()).toBe(nudged.json().startAt);
    });

    it("lets a booking be taken 5 or 15 minutes into a block, and refuses 20", async () => {
      // The block first, then the booking: the appointment side of the same rule.
      for (const [start, allowed] of [["10:55", true], ["10:45", true], ["10:40", false]] as const) {
        const day = nextDay();
        await created({ localStart: `${day}T09:00`, localEnd: `${day}T11:00` });
        const response = await book(`${day}T${start}`);
        if (allowed) expect(response.statusCode, `${start}: ${response.body}`).toBe(201);
        else expectBlocked(response, "TIME_BLOCKED");
      }
      // And a booking that ENDS inside a block, at the same three distances.
      for (const [start, allowed] of [["10:05", true], ["10:15", true], ["10:20", false]] as const) {
        const day = nextDay();
        await created({ localStart: `${day}T11:00`, localEnd: `${day}T13:00` });
        const response = await book(`${day}T${start}`);
        if (allowed) expect(response.statusCode, `${start}: ${response.body}`).toBe(201);
        else expectBlocked(response, "TIME_BLOCKED");
      }
    });

    it("lets a booking be moved 10 minutes onto a block, and refuses 20", async () => {
      const day = nextDay();
      await created({ localStart: `${day}T11:00`, localEnd: `${day}T12:00` });
      const appointment = await booked(`${day}T09:00`);
      const nudged = await move(appointment.id, { localStart: `${day}T10:10`, version: appointment.version });
      expect(nudged.statusCode, nudged.body).toBe(200);
      const refused = await move(appointment.id, { localStart: `${day}T10:20`, version: nudged.json().version });
      expectBlocked(refused, "TIME_BLOCKED");
      const [stored] = await db<{ startAt: Date }[]>`select start_at from appointments where id=${appointment.id}`;
      expect(stored!.startAt.toISOString()).toBe(nudged.json().startAt);
    });

    it("lets a service line be lengthened 15 minutes into a block, and refuses 16", async () => {
      const day = nextDay();
      const appointment = await booked(`${day}T09:00`);
      await created({ localStart: `${day}T10:15`, localEnd: `${day}T11:00` });
      const detail = await app.inject({
        method: "GET", url: `/api/appointments/${appointment.id}`, headers: { cookie: ownerCookie }
      });
      const lineId = (detail.json() as { services: { id: string }[] }).services[0]!.id;
      const edit = (durationMinutes: number) => app.inject({
        method: "PATCH", url: `/api/appointments/${appointment.id}/services/${lineId}`,
        headers: { cookie: ownerCookie }, payload: { durationMinutes }
      });
      // 90 minutes ends at 10:30, fifteen into the block. A line's duration is not on the grid -
      // it is a length, not a time - so 91 really is the sixteenth minute.
      const fifteen = await edit(90);
      expect(fifteen.statusCode, fifteen.body).toBe(200);
      const sixteen = await edit(91);
      expectBlocked(sixteen, "TIME_BLOCKED");
      const [stored] = await db<{ endAt: Date }[]>`select end_at from appointments where id=${appointment.id}`;
      expect(stored!.endAt.toISOString()).toBe(new Date(fifteen.json().endAt).toISOString());
    });

    it("judges each block on its own, so a booking clipping two blocks by ten minutes each is allowed", async () => {
      const day = nextDay();
      await created({ localStart: `${day}T09:00`, localEnd: `${day}T10:10` });
      await created({ localStart: `${day}T10:50`, localEnd: `${day}T12:00` });
      const response = await book(`${day}T10:00`);
      expect(response.statusCode, response.body).toBe(201);
      // And the mirror: a block laid over two bookings, fifteen minutes into each.
      const other = nextDay();
      await booked(`${other}T09:00`);
      await booked(`${other}T11:00`);
      const between = await blockTime({ localStart: `${other}T09:45`, localEnd: `${other}T11:15` });
      expect(between.statusCode, between.body).toBe(201);
    });

    it("has no block-versus-block rule: two blocks may overlap each other entirely", async () => {
      const day = nextDay();
      await created({ localStart: `${day}T09:00`, localEnd: `${day}T12:00` });
      const second = await blockTime({ localStart: `${day}T10:00`, localEnd: `${day}T11:00` });
      expect(second.statusCode, second.body).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * WHICH APPOINTMENTS OCCUPY TIME, WHICH IS THE SCHEDULING AUTHORITY'S QUESTION AND NOT THIS
   * SEAM'S.
   *
   * `scheduled`, `checked_in` and `in_service` occupy; `completed`, `cancelled` and `no_show` do
   * not. That set is not restated by the block routes - they call `findSchedulingConflicts`, the
   * function the booking and reschedule paths call - so these cases are really asserting that no
   * second copy of the literal has appeared. A yesterday full of finished grooms must not stop an
   * operator blocking that stretch out today.
   */
  describe("which appointments occupy the time", () => {
    it("allows a block over a cancelled appointment", async () => {
      const day = nextDay();
      const appointment = await booked(`${day}T10:00`);
      expect((await transition(appointment.id, "cancelled")).statusCode).toBe(200);
      const response = await blockTime({ localStart: `${day}T10:00`, localEnd: `${day}T11:00` });
      expect(response.statusCode, response.body).toBe(201);
    });

    it("allows a block over a completed appointment", async () => {
      const day = nextDay();
      const appointment = await booked(`${day}T10:00`);
      for (const status of ["checked_in", "in_service", "completed"]) {
        const stepped = await transition(appointment.id, status);
        expect(stepped.statusCode, stepped.body).toBe(200);
      }
      const response = await blockTime({ localStart: `${day}T10:00`, localEnd: `${day}T11:00` });
      expect(response.statusCode, response.body).toBe(201);
    });

    it("refuses a block over an appointment that is checked in but not finished", async () => {
      const day = nextDay();
      const appointment = await booked(`${day}T10:00`);
      expect((await transition(appointment.id, "checked_in")).statusCode).toBe(200);
      const response = await blockTime({ localStart: `${day}T10:00`, localEnd: `${day}T11:00` });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BLOCK_TIME_APPOINTMENT_CONFLICT");
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * A GROOMER IS A PERSON, NOT A ROOM.
   *
   * Neither half of this invariant has ever been scoped to a location: `findSchedulingConflicts`
   * refuses double-booking a groomer across the whole business, and `refuseStaffAvailability`
   * subtracts a groomer's blocks without consulting which shop they were filed at. So a block
   * filed at the second shop over an hour the same groomer is booked at the first is refused, and
   * that is the existing rule rather than a new one - the alternative would be a second occupancy
   * definition free to drift from the one the booking path enforces.
   *
   * The location does still decide the outcome where it can: a different groomer at the second
   * shop is a different person's day and is allowed.
   */
  describe("across locations", () => {
    it("refuses a second-shop block over the same groomer's first-shop appointment", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const response = await blockTime({
        localStart: `${day}T10:00`, localEnd: `${day}T11:00`, locationId: secondLocationId
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BLOCK_TIME_APPOINTMENT_CONFLICT");
    });

    it("allows a second-shop block for a groomer who is not booked", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const response = await blockTime({
        localStart: `${day}T10:00`, localEnd: `${day}T11:00`,
        employeeId: otherEmployeeId, locationId: secondLocationId
      });
      expect(response.statusCode, response.body).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * WHICH GROOMER OCCUPIES THE TIME IS `appointment_employees`, NOT `appointments.employee_id`.
   *
   * `findSchedulingConflicts` joins `appointments` to `appointment_employees` and matches on
   * `assignment.employee_id`. The appointment row's own `employee_id` column is never consulted by
   * it. That is deliberate - it is the seam multi-groomer work would grow back through - and its
   * doc comment says so in as many words: "so a second assigned groomer counts". Reusing that
   * function whole is what gives the block routes the same answer, and this describe is the
   * assertion that they really do inherit it rather than that the comment says they do.
   *
   * WHAT PAWSH ACTUALLY SUPPORTS TODAY, BECAUSE THE PREMISE IS EASY TO GET WRONG:
   *
   * migration 0015 introduced `appointment_employees` as a many-to-many and Pawsh took it back out
   * two migrations later. `0017_single_groomer_appointments` normalised every row to the
   * appointment's own groomer and then added `create unique index one_groomer_per_appointment on
   * appointment_employees(business_id,appointment_id)`, which is still on the table at head 0056.
   * The API agrees from the other side: `appointmentSchema` and `appointmentMoveSchema` both accept
   * an `employeeIds` array purely so their `superRefine` can refuse it by name - "An appointment can
   * only be assigned to one groomer" - and the only two writers of the table in `routes.ts` insert
   * from `const employeeIds=[primaryEmployeeId]`. `0027_staff_availability` lists that index as one
   * of the four database objects hard-enforcing one concurrent appointment per groomer.
   *
   * SO A GENUINE SECOND ASSIGNMENT ROW CANNOT BE CONSTRUCTED, by the API or by SQL, and the first
   * case below pins exactly that - if multi-groomer booking is ever restored, it fails and points
   * at the second case as the one that then needs the real two-row fixture.
   *
   * WHAT THE SECOND CASE BUILDS INSTEAD, and why it is the honest fixture rather than a weaker
   * one. The property under test is "the guard resolves the groomer through the assignment table".
   * The reachable configuration that isolates it is an appointment whose ASSIGNMENT names one
   * groomer while the appointment row's denormalised `employee_id` still names another: the
   * assigned groomer is, in the only sense the schema still permits, not the primary. The
   * appointment is booked through the real booking path and only the assignment is repointed
   * afterwards - one row, so `one_groomer_per_appointment` is respected and the fixture stays a
   * state the database would accept.
   *
   * It discriminates in both directions, which a two-row fixture would only do in one. A guard
   * reading `appointments.employee_id` would let the assigned groomer's block through (it is
   * refused here) AND would refuse the unassigned one's (it is allowed here). Either failure
   * catches a rewrite that stopped calling `findSchedulingConflicts`.
   */
  describe("through a secondary appointment_employees assignment", () => {
    /**
     * THE PREMISE, PINNED. Both doors to a second assignment are shut, and they are shut by
     * different things - the schema by choice, the index durably - so this states both.
     */
    it("cannot be given a second assignment, by the API or by the database", async () => {
      const day = nextDay();
      const appointment = await booked(`${day}T10:00`);

      // The booking body accepts the key only to refuse it, and says which rule it is refusing on.
      const twoOnCreate = await app.inject({
        method: "POST", url: "/api/appointments",
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: {
          locationId, customerId, petId, employeeId, employeeIds: [employeeId, otherEmployeeId],
          serviceIds: [serviceId], localStart: `${day}T14:00`,
          expectedLocationVersion: await locationVersion(locationId)
        }
      });
      expect(twoOnCreate.statusCode, twoOnCreate.body).toBe(400);
      expect(twoOnCreate.body).toContain("only be assigned to one groomer");

      // And the reschedule body refuses it identically, so an appointment cannot pick up a second
      // groomer after the fact either.
      const twoOnMove = await app.inject({
        method: "PATCH", url: `/api/appointments/${appointment.id}/schedule`,
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: {
          employeeId, employeeIds: [employeeId, otherEmployeeId],
          localStart: `${day}T15:00`, version: appointment.version,
          expectedLocationVersion: await locationVersion(locationId)
        }
      });
      expect(twoOnMove.statusCode, twoOnMove.body).toBe(400);
      expect(twoOnMove.body).toContain("only be assigned to one groomer");

      // THE DURABLE HALF. Even writing straight to the table, past every route, the unique index
      // 0017 added refuses the second row. This is why the fixture below repoints the one
      // assignment rather than adding to it.
      const secondRow = db`
        insert into appointment_employees(business_id,appointment_id,employee_id)
        values (${businessId},${appointment.id},${otherEmployeeId})
      `;
      await expect(secondRow, "one_groomer_per_appointment must refuse this")
        .rejects.toMatchObject({ code: "23505" });

      const [assignments] = await db<{ count: number }[]>`
        select count(*)::int as count from appointment_employees
        where appointment_id=${appointment.id}
      `;
      expect(assignments!.count, "exactly one assignment, before and after").toBe(1);
    });

    /**
     * THE REGRESSION ITSELF: the block routes follow the assignment, on create and on move alike.
     *
     * Both directions are asserted because on either alone the guard would be worthless - a
     * create-only guard is walked around by creating the block clear and moving it, and that is
     * as true of a groomer reached through the join as of any other.
     */
    it("refuses a block for the assigned groomer, and allows one for the unassigned column", async () => {
      const day = nextDay();
      // Booked the ordinary way, for the ordinary groomer, so nothing about the appointment itself
      // is synthetic: the times, the services and both employee references are the route's own.
      const appointment = await booked(`${day}T10:00`);
      const [before] = await db<{ employeeId: string }[]>`
        select employee_id from appointment_employees where appointment_id=${appointment.id}
      `;
      expect(before!.employeeId, "the booking assigns its own groomer").toBe(employeeId);

      // The one edit: the assignment moves to a groomer the appointment row does not name. This is
      // the closest state to a secondary assignment the schema still allows, and it is the state
      // that tells the two candidate occupancy definitions apart.
      await db`
        update appointment_employees set employee_id=${otherEmployeeId}
        where appointment_id=${appointment.id} and employee_id=${employeeId}
      `;
      const [assignment] = await db<{ employeeId: string }[]>`
        select employee_id from appointment_employees where appointment_id=${appointment.id}
      `;
      expect(assignment!.employeeId, "the repoint has to have landed").toBe(otherEmployeeId);
      const [denormalised] = await db<{ employeeId: string }[]>`
        select employee_id from appointments where id=${appointment.id}
      `;
      expect(denormalised!.employeeId, "the appointment row still names the other groomer")
        .toBe(employeeId);

      // CREATE. The assigned groomer's hour is spoken for, and the block is refused as hard as it
      // would be for a primary - same code, same non-overridability, and it names the appointment.
      const refused = await blockTime({
        localStart: `${day}T10:00`, localEnd: `${day}T11:00`, employeeId: otherEmployeeId
      });
      expect(refused.statusCode, refused.body).toBe(409);
      const payload = refused.json() as ConflictBody;
      expect(payload.code).toBe("BLOCK_TIME_APPOINTMENT_CONFLICT");
      expect(payload.canOverride).toBe(false);
      expect(payload.conflicts.map((row) => row.appointmentId)).toEqual([appointment.id]);

      // MOVE. The block is created somewhere legitimate for the same groomer and then walked onto
      // the appointment, which is the way a create-only guard is defeated.
      const block = await created({
        localStart: `${day}T13:00`, localEnd: `${day}T14:00`, employeeId: otherEmployeeId
      });
      const moved = await patch(block.id, await movePayload({
        version: block.version, localStart: `${day}T10:00`, localEnd: `${day}T11:00`,
        employeeId: otherEmployeeId
      }));
      expect(moved.statusCode, moved.body).toBe(409);
      expect((moved.json() as ConflictBody).conflicts.map((row) => row.appointmentId))
        .toEqual([appointment.id]);
      // A refused move leaves the block exactly where it was.
      const [unmoved] = await db<{ version: number; startAt: Date }[]>`
        select version,start_at from blocked_times where id=${block.id}
      `;
      expect(unmoved!.version).toBe(block.version);
      expect(unmoved!.startAt.toISOString()).toBe(block.startAt);

      // THE OTHER DIRECTION. The groomer the APPOINTMENT ROW names is no longer assigned to it, so
      // that hour is not spoken for on their calendar and the block is written. This is the half a
      // guard reading `appointments.employee_id` would fail, and it is what makes the case above
      // evidence about the join rather than about employee ids in general.
      const allowed = await blockTime({
        localStart: `${day}T10:00`, localEnd: `${day}T11:00`, employeeId
      });
      expect(allowed.statusCode, allowed.body).toBe(201);

      // TEARDOWN, so nothing after this reads the denormalisation this case introduced. The block
      // goes first: putting the assignment back while it was still there would leave the very
      // overlap the suite's closing invariant sweeps for.
      await db`delete from blocked_times where id=${(allowed.json() as BlockRow).id}`;
      await db`
        update appointment_employees set employee_id=${employeeId}
        where appointment_id=${appointment.id} and employee_id=${otherEmployeeId}
      `;
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * ANOTHER SALON'S BOOKINGS ARE NOT IN ANYBODY'S WAY, AND NEVER APPEAR IN A REFUSAL.
   *
   * The check runs under `setTenant` with `business_id` in the predicate, so a rival's appointment
   * cannot reach it through either. Both halves are asserted, because they fail differently: a
   * scoping bug that refuses is a salon told it cannot block its own afternoon, and a scoping bug
   * that merely leaks hands one salon another salon's appointment ids.
   */
  describe("tenant scoping", () => {
    it("ignores another salon's appointment in the same window", async () => {
      const day = nextDay();
      await rivalBook(`${day}T10:00`);
      const response = await blockTime({ localStart: `${day}T10:00`, localEnd: `${day}T11:00` });
      expect(response.statusCode, response.body).toBe(201);
    });

    it("names only this salon's appointments when it does refuse", async () => {
      const day = nextDay();
      const mine = await booked(`${day}T10:00`);
      const theirs = await rivalBook(`${day}T10:00`);
      const response = await blockTime({ localStart: `${day}T10:00`, localEnd: `${day}T11:00` });
      expect(response.statusCode, response.body).toBe(409);
      const payload = response.json() as ConflictBody;
      expect(payload.conflicts.map((row) => row.appointmentId)).toEqual([mine.id]);
      expect(response.body).not.toContain(theirs.id);
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * THE EDIT ROUTE, WHICH IS THE HALF THAT MAKES THE OTHER HALF WORTH HAVING.
   *
   * A guard on create alone is walked around in two requests: block the hour before, then move it
   * one hour later. These cases are that walk-around, refused - and the metadata case is the one
   * that must NOT be refused, because a block that legitimately predates a booking still has to be
   * recolourable and re-labellable.
   */
  describe("moving a block", () => {
    it("refuses a move onto an appointment", async () => {
      const day = nextDay();
      await booked(`${day}T13:00`);
      const block = await created({ localStart: `${day}T11:00`, localEnd: `${day}T12:00` });
      const response = await patch(block.id, await movePayload({
        version: block.version, localStart: `${day}T13:00`, localEnd: `${day}T14:00`
      }));
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BLOCK_TIME_APPOINTMENT_CONFLICT");

      // AND THE REFUSAL LEFT NOTHING BEHIND. A guard that rolls back its transaction but has
      // already bumped the version hands every open editor a stale token for a block that did not
      // move.
      const [stored] = await db<{ version: number; startAt: Date }[]>`
        select version,start_at from blocked_times where id=${block.id}
      `;
      expect(stored!.version).toBe(block.version);
      expect(stored!.startAt.toISOString()).toBe(block.startAt);
    });

    it("refuses a move that reassigns the block onto another groomer's appointment", async () => {
      const day = nextDay();
      await booked(`${day}T13:00`, otherEmployeeId);
      const block = await created({ localStart: `${day}T13:00`, localEnd: `${day}T14:00` });
      // The block is where it is legitimately - `employeeId` is free at 13:00 - and only the
      // groomer changes. Locking the OUTGOING employee alone would find nothing and let this
      // through, which is the exact defect the sorted two-employee acquisition exists to prevent.
      const response = await patch(block.id, await movePayload({
        version: block.version, localStart: `${day}T13:00`, localEnd: `${day}T14:00`,
        employeeId: otherEmployeeId
      }));
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BLOCK_TIME_APPOINTMENT_CONFLICT");
    });

    it("allows a move off an appointment onto free time", async () => {
      const day = nextDay();
      await booked(`${day}T13:00`);
      const block = await created({ localStart: `${day}T11:00`, localEnd: `${day}T12:00` });
      const response = await patch(block.id, await movePayload({
        version: block.version, localStart: `${day}T15:00`, localEnd: `${day}T16:00`
      }));
      expect(response.statusCode, response.body).toBe(200);
    });

    /**
     * A METADATA-ONLY PATCH IS NOT A MOVE AND IS NOT GUARDED.
     *
     * The block here sits on top of an appointment that was booked after it - a legitimate state,
     * because the booking path refuses a booking onto a block and this one was made by moving the
     * appointment nowhere near it and then blocking beside it. Reason and colour do not touch the
     * interval, so there is nothing for the guard to decide and nothing for the lock to protect.
     * If this ever starts returning 409, an operator can no longer fix a typo in the label of a
     * block they need to keep.
     */
    it("still allows a reason and colour edit on a block that overlaps an appointment", async () => {
      const day = nextDay();
      const block = await created({ localStart: `${day}T10:00`, localEnd: `${day}T11:00` });
      // The overlap is manufactured in SQL rather than through the API, because the API is exactly
      // what now refuses to manufacture it. This is the legacy row: an overlap that predates the
      // guard and still has to be editable.
      const appointmentId = (await booked(`${day}T14:00`)).id;
      // `scheduled_local_start` moves with the instant, or migration 0051's
      // `appointment_local_start_matches_instant` refuses the fixture - the same constraint that
      // keeps a real appointment's wall clock honest.
      await db`
        update appointments appointment
        set start_at=block.start_at, end_at=block.end_at,
          scheduled_local_start=block.start_at at time zone appointment.scheduling_timezone
        from blocked_times block
        where block.id=${block.id} and appointment.id=${appointmentId}
      `;

      const response = await patch(block.id, { version: block.version, reason: "Relabelled", colorSlot: 4 });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ reason: "Relabelled", colorSlot: 4 });

      // The interval did not move, which is the reason the guard had nothing to say.
      const [stored] = await db<{ startAt: Date; endAt: Date }[]>`
        select start_at,end_at from blocked_times where id=${block.id}
      `;
      expect(stored!.startAt.toISOString()).toBe(block.startAt);
      expect(stored!.endAt.toISOString()).toBe(block.endAt);

      // Put the appointment back so the invariant sweep at the end of this file is not reading a
      // row this case deliberately corrupted.
      expect((await transition(appointmentId, "cancelled")).statusCode).toBe(200);
    });

    /**
     * A MULTI-DAY BLOCK SURVIVES A COLOUR EDIT BYTE FOR BYTE.
     *
     * This is the block the edit dialog deliberately refuses to reschedule - a single-date control
     * cannot express a window that opens on one day and closes on another - while leaving its note
     * and colour editable. So the metadata branch is the ONLY way such a block is ever written,
     * and if it recomputed, rounded or truncated a time column, a week-long holiday would come
     * back as something else and nothing in the UI would have asked it to.
     *
     * It spans 2029-03-11, the day Pacific time loses an hour, so the window is 32 hours of wall
     * clock and 31 of elapsed time. Any implementation that rebuilds the instants from the local
     * pair - or the local pair from the instants - in the wrong zone lands an hour out here and
     * nowhere else. Every column is read as TEXT so the driver cannot reinterpret the naive pair
     * on its way back, which is the exact defect migration 0051 exists for.
     */
    it("preserves a multi-day block's instants exactly through a colour-only edit", async () => {
      const block = await created({
        localStart: "2029-03-10T22:00", localEnd: "2029-03-12T06:00", employeeId: otherEmployeeId
      });
      const times = async () => {
        const [row] = await db<{
          startAt: string; endAt: string; localStart: string; localEnd: string; zone: string;
        }[]>`
          select to_char(start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS') as start_at,
            to_char(end_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS') as end_at,
            to_char(scheduled_local_start,'YYYY-MM-DD"T"HH24:MI:SS.MS') as local_start,
            to_char(scheduled_local_end,'YYYY-MM-DD"T"HH24:MI:SS.MS') as local_end,
            scheduling_timezone as zone
          from blocked_times where id=${block.id}
        `;
        return row!;
      };
      const before = await times();
      // The fixture really is the shape this case is about: two calendar days apart, and 31 hours
      // of elapsed time across a 32-hour wall clock.
      expect(before.localStart).toBe("2029-03-10T22:00:00.000");
      expect(before.localEnd).toBe("2029-03-12T06:00:00.000");
      expect(new Date(`${before.endAt}Z`).getTime() - new Date(`${before.startAt}Z`).getTime())
        .toBe(31 * 60 * 60 * 1000);

      const response = await patch(block.id, { version: block.version, colorSlot: 7 });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ colorSlot: 7, version: block.version + 1 });

      expect(await times()).toEqual(before);
    });

    /**
     * A RE-SEND OF THE STORED COORDINATES IS NOT A MOVE EITHER.
     *
     * `scheduleChanged` is measured against what is STORED, not against which fields the request
     * carried, and the guard rides that same flag rather than computing a second determination. A
     * dialog that always posts all four schedule fields must not be refused for re-stating where
     * the block already is.
     */
    it("allows a PATCH that re-sends the block's own coordinates unchanged", async () => {
      const day = nextDay();
      const block = await created({ localStart: `${day}T10:00`, localEnd: `${day}T11:00` });
      const response = await patch(block.id, {
        ...await movePayload({
          version: block.version, localStart: `${day}T10:00`, localEnd: `${day}T11:00`
        }),
        reason: "Same place, new label"
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ reason: "Same place, new label" });
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * TWO CHECKS THAT CAN BOTH FAIL, AND WHICH ONE ANSWERS.
   *
   * `version` says "your copy of this block is current"; the appointment guard says "the placement
   * you are asking for is free". A request can be wrong about both, and the route decides the
   * version first - deliberately. A stale caller composed their coordinates against a block that
   * has since moved, so a conflict computed from them describes a placement nobody is proposing any
   * more, and naming appointments would send an operator to cancel a booking they never needed to
   * touch. "Refresh and try again" is true whatever else is wrong.
   *
   * It also means a stale request never reaches the lock.
   */
  describe("against the optimistic version check", () => {
    it("answers STALE_BLOCKED_TIME when the request is both stale and overlapping", async () => {
      const day = nextDay();
      await booked(`${day}T13:00`);
      const block = await created({ localStart: `${day}T11:00`, localEnd: `${day}T12:00` });
      const staleVersion = block.version;

      // Somebody else edits the block, so the caller's token is now behind.
      const relabelled = await patch(block.id, { version: block.version, reason: "Moved on by someone else" });
      expect(relabelled.statusCode, relabelled.body).toBe(200);

      const response = await patch(block.id, await movePayload({
        version: staleVersion, localStart: `${day}T13:00`, localEnd: `${day}T14:00`
      }));
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("STALE_BLOCKED_TIME");
    });

    it("answers BLOCK_TIME_APPOINTMENT_CONFLICT when only the placement is wrong", async () => {
      const day = nextDay();
      await booked(`${day}T13:00`);
      const block = await created({ localStart: `${day}T11:00`, localEnd: `${day}T12:00` });
      const response = await patch(block.id, await movePayload({
        version: block.version, localStart: `${day}T13:00`, localEnd: `${day}T14:00`
      }));
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BLOCK_TIME_APPOINTMENT_CONFLICT");
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * WHAT THE REFUSAL SAYS, BECAUSE A 409 AN OPERATOR CANNOT ACT ON IS A DEAD END.
   *
   * The salon owner is standing at the desk trying to block out an afternoon. "Conflict" tells them
   * nothing; the appointment that is in the way, on the clock they are looking at, tells them what
   * to move. The machine-readable half follows `SCHEDULING_CONFLICT` field for field so a client
   * that already renders one conflict list renders this one.
   */
  describe("what the refusal carries", () => {
    it("names the offending appointment in both halves of the payload", async () => {
      const day = nextDay();
      const appointment = await booked(`${day}T10:00`);
      const response = await blockTime({ localStart: `${day}T09:30`, localEnd: `${day}T12:00` });
      expect(response.statusCode, response.body).toBe(409);
      const payload = response.json() as ConflictBody;

      expect(payload.code).toBe("BLOCK_TIME_APPOINTMENT_CONFLICT");
      expect(payload.canOverride).toBe(false);
      expect(payload.conflicts).toHaveLength(1);
      expect(payload.conflicts[0]!.appointmentId).toBe(appointment.id);

      const [stored] = await db<{ startAt: Date; endAt: Date }[]>`
        select start_at,end_at from appointments where id=${appointment.id}
      `;
      expect(payload.conflicts[0]!.startsAt).toBe(stored!.startAt.toISOString());
      expect(payload.conflicts[0]!.endsAt).toBe(stored!.endAt.toISOString());

      // The prose names the groomer and the salon's own wall clock - never the instant, which
      // reads as the wrong hour to everybody outside UTC.
      expect(payload.error).toContain(employeeName);
      expect(payload.error).toContain(day);
      expect(payload.error).toContain("10:00");
      expect(payload.error).toContain("11:00");
      expect(payload.error).not.toContain("Z");
    });

    it("counts every appointment the block would cover", async () => {
      const day = nextDay();
      const first = await booked(`${day}T10:00`);
      const second = await booked(`${day}T11:00`);
      const response = await blockTime({ localStart: `${day}T09:00`, localEnd: `${day}T13:00` });
      expect(response.statusCode, response.body).toBe(409);
      const payload = response.json() as ConflictBody;
      expect(payload.conflicts.map((row) => row.appointmentId).sort())
        .toEqual([first.id, second.id].sort());
      expect(payload.error).toContain("one more");
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * NON-BYPASSABLE, WHICH IS THE WHOLE POINT OF CALLING IT AN INVARIANT.
   *
   * `SCHEDULING_CONFLICT` can be overridden by a manager holding
   * `appointments.override_conflict`, because two bookings in one hour is a judgement call a salon
   * is allowed to make. A block over a booking is not: it is a calendar that contradicts itself,
   * and there is no operator intent that makes it coherent. `canOverride` is therefore a constant
   * rather than a permission lookup, and no flag reaches the routes. The tolerance did not change
   * this: an intersection past fifteen minutes is refused whoever asks and whatever they send.
   */
  describe("non-bypassable", () => {
    it("ignores an overrideConflict flag on create and still refuses", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const response = await blockTime({
        localStart: `${day}T10:00`, localEnd: `${day}T11:00`,
        extra: { overrideConflict: true, availabilityOverride: true, force: true }
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({
        code: "BLOCK_TIME_APPOINTMENT_CONFLICT", canOverride: false
      });
    });

    it("refuses an override flag on edit outright, because the update schema is strict", async () => {
      const day = nextDay();
      await booked(`${day}T13:00`);
      const block = await created({ localStart: `${day}T11:00`, localEnd: `${day}T12:00` });
      const response = await patch(block.id, {
        ...await movePayload({
          version: block.version, localStart: `${day}T13:00`, localEnd: `${day}T14:00`
        }),
        overrideConflict: true
      });
      expect(response.statusCode).toBe(400);
    });

    it("never reports canOverride true, whoever is asking", async () => {
      const day = nextDay();
      await booked(`${day}T10:00`);
      const response = await blockTime({ localStart: `${day}T10:00`, localEnd: `${day}T11:00` });
      // The owner holds every permission in the workspace, including
      // `appointments.override_conflict`. If `canOverride` were computed rather than constant,
      // this is the caller it would be computed true for.
      expect(response.json().canOverride).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * THE RACES, WHICH ARE THE REASON THE LOCK IS THERE.
   *
   * Every case above would pass against a guard that reads and writes outside
   * `lockSchedulingResources`, because a sequential test never interleaves. These three do not:
   * both requests are held at `beforeLock` until both have arrived and then released into one
   * contest for the same per-employee advisory lock. Whichever loses re-reads under the lock and
   * finds what the winner committed.
   *
   * Each case asserts BOTH halves, because they are different claims: exactly one request
   * succeeded, AND no overlap exists in the database afterwards. A guard could satisfy the first
   * by failing both.
   */
  describe("under genuine concurrency", () => {
    it("lets exactly one of a booking and a block win the same slot", async () => {
      const day = nextDay();
      const before = await overlapCount();
      armBarrier();
      const [booking, block] = await Promise.all([
        book(`${day}T10:00`),
        blockTime({ localStart: `${day}T10:00`, localEnd: `${day}T11:00` })
      ]);
      const wins = [booking, block].filter((response) => response.statusCode === 201);
      expect(wins, `${booking.statusCode} ${booking.body} / ${block.statusCode} ${block.body}`)
        .toHaveLength(1);
      const loser = [booking, block].find((response) => response.statusCode !== 201)!;
      expect(loser.statusCode).toBe(409);
      // Whichever way round it fell, the loser was refused by the invariant rather than by a
      // deadlock or a serialisation failure.
      expect(["TIME_BLOCKED", "BLOCK_TIME_APPOINTMENT_CONFLICT"]).toContain(loser.json().code);
      expect(await overlapCount()).toBe(before);
    });

    /**
     * WHAT THIS ONE ACTUALLY PINS, STATED PLAINLY.
     *
     * Both requests are held at the gate and released together, but the block route does far less
     * work after the lock than the reschedule route does, so in practice the block commits first
     * and the reschedule is refused by `TIME_BLOCKED` - the appointment side's guard, which
     * predates this seam. Removing the block route's lock therefore does NOT fail this case, while
     * removing the guard does. It is here because "an operator moving an appointment and an
     * operator blocking that hour at the same moment" is a real thing a busy salon does and the
     * invariant has to survive it; the three cases either side of it are what pin the block side's
     * lock, and the cross-groomer one below is what pins the SIZE of the lock set.
     */
    it("lets exactly one of an appointment move and a block win the same slot", async () => {
      const day = nextDay();
      const appointment = await booked(`${day}T09:00`);
      const before = await overlapCount();
      armBarrier();
      const [moved, block] = await Promise.all([
        move(appointment.id, { localStart: `${day}T14:00`, version: appointment.version }),
        blockTime({ localStart: `${day}T14:00`, localEnd: `${day}T15:00` })
      ]);
      const wins = [moved.statusCode === 200, block.statusCode === 201].filter(Boolean);
      expect(wins, `${moved.statusCode} ${moved.body} / ${block.statusCode} ${block.body}`)
        .toHaveLength(1);
      const loser = moved.statusCode === 200 ? block : moved;
      expect(loser.statusCode).toBe(409);
      expect(["TIME_BLOCKED", "BLOCK_TIME_APPOINTMENT_CONFLICT"]).toContain(loser.json().code);
      expect(await overlapCount()).toBe(before);
    });

    it("lets exactly one of a block move and a booking win the same slot", async () => {
      const day = nextDay();
      const block = await created({ localStart: `${day}T09:00`, localEnd: `${day}T10:00` });
      const before = await overlapCount();
      const payload = await movePayload({
        version: block.version, localStart: `${day}T14:00`, localEnd: `${day}T15:00`
      });
      armBarrier();
      const [booking, moved] = await Promise.all([
        book(`${day}T14:00`),
        patch(block.id, payload)
      ]);
      const wins = [booking.statusCode === 201, moved.statusCode === 200].filter(Boolean);
      expect(wins, `${booking.statusCode} ${booking.body} / ${moved.statusCode} ${moved.body}`)
        .toHaveLength(1);
      const loser = booking.statusCode === 201 ? moved : booking;
      expect(loser.statusCode).toBe(409);
      expect(["TIME_BLOCKED", "BLOCK_TIME_APPOINTMENT_CONFLICT"]).toContain(loser.json().code);
      expect(await overlapCount()).toBe(before);
    });

    /**
     * AND A CROSS-GROOMER MOVE RACING A BOOKING ON THE DESTINATION.
     *
     * This is the case a one-employee lock set gets wrong and nothing else catches. The block is
     * moving FROM `employeeId` TO `otherEmployeeId`; the concurrent booking is on
     * `otherEmployeeId`. Lock only the outgoing groomer and the two transactions never meet, both
     * commit, and the calendar ends up holding exactly the state this seam exists to forbid.
     */
    it("locks the destination groomer on a cross-groomer move", async () => {
      const day = nextDay();
      const block = await created({ localStart: `${day}T09:00`, localEnd: `${day}T10:00` });
      const before = await overlapCount();
      const payload = await movePayload({
        version: block.version, localStart: `${day}T14:00`, localEnd: `${day}T15:00`,
        employeeId: otherEmployeeId
      });
      armBarrier();
      const [booking, moved] = await Promise.all([
        book(`${day}T14:00`, otherEmployeeId),
        patch(block.id, payload)
      ]);
      const wins = [booking.statusCode === 201, moved.statusCode === 200].filter(Boolean);
      expect(wins, `${booking.statusCode} ${booking.body} / ${moved.statusCode} ${moved.body}`)
        .toHaveLength(1);
      const loser = booking.statusCode === 201 ? moved : booking;
      expect(loser.statusCode).toBe(409);
      expect(["TIME_BLOCKED", "BLOCK_TIME_APPOINTMENT_CONFLICT"]).toContain(loser.json().code);
      expect(await overlapCount()).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * THE SWEEP. Everything above ran against one workspace, and this asks the database directly
   * whether any of it left the state the invariant forbids - including the cases that were
   * supposed to be allowed, where a boundary written one character wrong produces a silent overlap
   * rather than a failed assertion.
   */
  it("leaves no blocked time intersecting an occupying appointment beyond the tolerance anywhere in the workspace", async () => {
    expect(await overlapCount()).toBe(0);
    // The tolerated intersections the cases above wrote are really there, so the sweep is
    // counting something rather than passing over an empty join.
    expect(await overlapCount(0)).toBeGreaterThan(0);
  });
});
