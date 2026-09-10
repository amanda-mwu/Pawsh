import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * A BLOCKED TIME IS ENFORCED. THIS SUITE IS ABOUT WHETHER IT CAN BE SEEN.
 *
 * `blocked_times` has existed since 0001 and `POST /api/blocked-times` has written rows into it
 * for as long as there has been a "Block team time" action. The availability authority subtracts
 * those rows at step 5 and refuses the window with `TIME_BLOCKED`. Until `GET /api/blocked-times`
 * the ONLY read of the table in the whole API was the one inside that refusal, so dragging an
 * appointment onto a blocked half hour was refused by a region the calendar drew nothing for.
 * Human QA hit exactly that: the seed blocks a groomer 12:00-12:30, the move is correctly
 * refused, and the grid shows empty space where the reason should be.
 *
 * So the load-bearing assertion in this file is not "the endpoint returns rows". It is that THE
 * SAME INTERVAL IS BOTH RETURNED AND REFUSED - visibility and enforcement describing one fact.
 *
 * EVERY TIME HERE IS AMERICA/LOS_ANGELES, DELIBERATELY. A UTC salon cannot fail the wall-clock
 * case: the bug migration 0051 exists for - handing a `timestamp without time zone` to
 * postgres.js, which parses it with `new Date(x)` in the API HOST's timezone - is a no-op when
 * the host and the salon agree. At UTC-8 a 12:00 block would come back as 20:00, which is the
 * 17:00-for-a-10:00-groom defect 0051 was written about. The February dates are PST (UTC-8) and
 * the July one is PDT (UTC-7), so a fixed offset cannot pass both either.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "blocked-time-visibility-secret-32-characters",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const sessionCookie = (response: { headers: Record<string, unknown> }) => {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
};

/** The wall-clock form a calendar column places: no seconds, no zone, never an instant. */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** PST, the day the visible block sits on. */
const DAY = "2027-02-09";
/** The day before and the day after, for the window edges. */
const DAY_BEFORE = "2027-02-08";
const DAY_AFTER = "2027-02-10";
/** PDT, so the summer offset differs from the winter one. */
const SUMMER_DAY = "2027-07-13";
/** Far from every window above, for the rows that must not be reachable from one. */
const FAR_DAY = "2027-09-21";

interface BlockRow {
  id: string;
  employeeId: string;
  employeeName: string;
  locationId: string;
  reason: string | null;
  startAt: string;
  endAt: string;
  schedulingTimezone: string;
  scheduledLocalStart: string;
  scheduledLocalEnd: string;
}

describeDatabase("a blocked time is visible on the calendar it already governs", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string, rivalCookie: string;
  let businessId: string, locationId: string, otherLocationId: string;
  let customerId: string, petId: string, serviceId: string;
  let employeeId: string, employeeName: string;
  let secondEmployeeId: string;
  let rivalBusinessId: string;
  const suffix = crypto.randomUUID().slice(0, 8);

  const locationVersion = async (cookie = ownerCookie) => {
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    return me.json().business.locationVersion as number;
  };

  /** Through the real create route, which is the path an operator's block takes. */
  const blockTime = async (input: {
    localStart: string; localEnd: string; reason: string;
    employeeId?: string; locationId?: string; cookie?: string;
  }) => {
    const cookie = input.cookie ?? ownerCookie;
    return app.inject({
      method: "POST", url: "/api/blocked-times", headers: { cookie },
      payload: {
        employeeId: input.employeeId ?? employeeId,
        locationId: input.locationId ?? locationId,
        localStart: input.localStart, localEnd: input.localEnd, reason: input.reason,
        expectedLocationVersion: await locationVersion(cookie)
      }
    });
  };

  const created = async (input: Parameters<typeof blockTime>[0]) => {
    const response = await blockTime(input);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  };

  const read = async (query: Record<string, string | number> = {}, cookie = ownerCookie) => {
    const search = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)])
    ).toString();
    const response = await app.inject({
      method: "GET", url: `/api/blocked-times${search ? `?${search}` : ""}`, headers: { cookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as BlockRow[];
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

  const setActiveLocation = (id: string) => app.inject({
    method: "POST", url: "/api/me/location",
    headers: { cookie: ownerCookie, origin: config.APP_ORIGIN }, payload: { locationId: id }
  });

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `block-visibility-${suffix}@example.test`,
      password: "correct horse blocked visibility", businessName: `Block Visibility Salon ${suffix}`
    }});
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = sessionCookie(signup);
    ({ businessId, locationId } = signup.json());
    await db`update locations set timezone='America/Los_Angeles' where id=${locationId}`;

    // A second shop for the same tenant. One shop's lunch break is not the other shop's, and the
    // grid being painted is one shop's grid.
    const [other] = await db<{ id: string }[]>`
      insert into locations(business_id,name,address,timezone)
      values (${businessId},'Second Shop','2 Second St','America/Los_Angeles') returning id`;
    otherLocationId = other!.id;

    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
    serviceId = (await post("/api/services", {
      name: `Block Groom ${suffix}`, baseDurationMinutes: 60, basePriceMinor: 7000
    })).json().id;
    employeeName = `Bianca Block ${suffix}`;
    employeeId = (await post("/api/employees", {
      displayName: employeeName, serviceIds: [serviceId]
    })).json().id;
    secondEmployeeId = (await post("/api/employees", {
      displayName: `Edgar Edge ${suffix}`, serviceIds: [serviceId]
    })).json().id;
    customerId = (await post("/api/customers", {
      firstName: "Block", lastName: "Client", preferredContactMethod: "none", emailAllowed: false
    })).json().id;
    petId = (await post("/api/pets", { customerId, name: "Block Pet", species: "dog" })).json().id;

    // Nine to five every weekday for both groomers, so no fixture date lands in the unconfigured
    // fail-open branch and a refusal is never ambiguous about which step produced it.
    for (const staffId of [employeeId, secondEmployeeId]) {
      for (let weekday = 0; weekday < 7; weekday += 1) {
        await db`
          insert into employee_working_hours(business_id,employee_id,weekday,start_time,end_time)
          values (${businessId},${staffId},${weekday},'09:00','17:00')
        `;
      }
    }

    // A rival tenant with its own shop, its own groomer and its own block at the SAME wall-clock
    // time on the SAME date, so a leak would be invisible to any assertion that only counted rows.
    const rival = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `block-rival-${suffix}@example.test`,
      password: "correct horse rival visibility", businessName: `Rival Salon ${suffix}`
    }});
    expect(rival.statusCode, rival.body).toBe(201);
    rivalCookie = sessionCookie(rival);
    const rivalLocationId = rival.json().locationId as string;
    rivalBusinessId = rival.json().businessId as string;
    await db`update locations set timezone='America/Los_Angeles' where id=${rivalLocationId}`;
    const rivalEmployeeId = (await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: rivalCookie },
      payload: { displayName: `Rival Groomer ${suffix}`, serviceIds: [] }
    })).json().id as string;
    await created({
      localStart: `${DAY}T12:00`, localEnd: `${DAY}T12:30`, reason: "Rival lunch",
      employeeId: rivalEmployeeId, locationId: rivalLocationId, cookie: rivalCookie
    });
  }, 60_000);

  afterAll(async () => { await app.close(); await db.end(); });

  // APPOINTMENTS BOOKED AS FIXTURES ARE LEFT IN PLACE RATHER THAN DELETED. Every booking route
  // records an idempotency row in `scheduling_request_replays` that references the appointment it
  // produced, so a bare `delete from appointments` is refused by that foreign key - which is the
  // constraint doing its job: the replay record must not outlive the thing it is a record of.
  // Nothing here needs them gone. Each case books into a slot no other case touches, and the whole
  // suite runs against a business created fresh under `suffix`, so leftovers cannot reach a
  // subsequent run either.

  describe("the block the calendar could not draw", () => {
    let blockId = "";

    beforeAll(async () => {
      blockId = await created({
        localStart: `${DAY}T12:00`, localEnd: `${DAY}T12:30`, reason: "QA seed: Lunch"
      });
    });

    it("returns the block with everything a calendar column needs to draw it", async () => {
      const rows = await read({ localDate: DAY, days: 1 });
      const block = rows.find((row) => row.id === blockId);
      expect(block, JSON.stringify(rows)).toBeDefined();
      // The whole contract in one assertion, because the calendar codes against exactly this.
      expect(block).toMatchObject({
        id: blockId,
        employeeId,
        employeeName,
        locationId,
        reason: "QA seed: Lunch",
        schedulingTimezone: "America/Los_Angeles",
        scheduledLocalStart: `${DAY}T12:00`,
        scheduledLocalEnd: `${DAY}T12:30`
      });
      // The instants are carried too, and they are the authoritative pair the wall clock above is
      // derived from. PST is UTC-8, so 12:00 at the salon is 20:00Z.
      expect(block!.startAt).toBe(`${DAY}T20:00:00.000Z`);
      expect(block!.endAt).toBe(`${DAY}T20:30:00.000Z`);
    });

    it("refuses the same interval for scheduling, so what is drawn is what is enforced", async () => {
      // ONE test, on purpose. The endpoint would be worth nothing if the grid drew a region the
      // scheduler did not honour, or the scheduler honoured a region the grid did not draw.
      const rows = await read({ localDate: DAY, days: 1 });
      const block = rows.find((row) => row.id === blockId)!;
      expect(block.scheduledLocalStart).toBe(`${DAY}T12:00`);

      const refused = await book(block.scheduledLocalStart);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: "TIME_BLOCKED", employeeId, localDate: DAY });

      // And the block is the only thing in the way: the hour before it books cleanly, so the
      // refusal above is the block rather than a closed salon or an unstaffed day.
      const clear = await book(`${DAY}T09:00`);
      expect(clear.statusCode, clear.body).toBe(201);
    });

    it("states the salon's wall clock, not the host's reading of a naive timestamp", async () => {
      // THE REGRESSION MIGRATION 0051 WAS WRITTEN ABOUT. `scheduled_local_start` is
      // `timestamp without time zone`; handing it to postgres.js yields a Date built by reading a
      // zone-less string in the API host's timezone, and the client then prints the leading
      // YYYY-MM-DDTHH:mm of an INSTANT. On this UTC-8 salon that is 20:00 for a 12:00 block.
      const block = (await read({ localDate: DAY, days: 1 })).find((row) => row.id === blockId)!;
      expect(typeof block.scheduledLocalStart).toBe("string");
      expect(block.scheduledLocalStart).toMatch(WALL_CLOCK);
      expect(block.scheduledLocalEnd).toMatch(WALL_CLOCK);
      expect(block.scheduledLocalStart).not.toContain("Z");
      expect(block.scheduledLocalStart.slice(11)).toBe("12:00");
      // Not 20:00, which is what the instant reads as and what the defect produced.
      expect(block.scheduledLocalStart).not.toBe(block.startAt.slice(0, 16));

      // And the offset is not a constant. The same 12:00 in July is PDT, an hour off PST, so a
      // fixed-offset implementation passes February and fails here.
      const summerId = await created({
        localStart: `${SUMMER_DAY}T12:00`, localEnd: `${SUMMER_DAY}T12:30`, reason: "Summer lunch"
      });
      const summer = (await read({ localDate: SUMMER_DAY, days: 1 }))
        .find((row) => row.id === summerId)!;
      expect(summer.scheduledLocalStart).toBe(`${SUMMER_DAY}T12:00`);
      expect(summer.startAt).toBe(`${SUMMER_DAY}T19:00:00.000Z`);
    });

    it("agrees with the local date GET /api/appointments files the same window under", async () => {
      // The two answers are painted onto one grid, so they must not disagree about which day a
      // 12:00 slot belongs to. The appointment is booked at 13:30, clear of the block.
      //
      // ON THE SECOND GROOMER, because a block may no longer be laid over a booked appointment.
      // This fixture outlives its own case and the "window" block fixtures below sit at 14:00 on
      // this same day, which is inside a 13:30 groom's hour. Which groomer the appointment is on
      // is irrelevant to what this case asserts - it compares the local DAY the two reads file a
      // row under - so it moves aside rather than the block fixtures moving.
      const booked = await book(`${DAY}T13:30`, { employeeId: secondEmployeeId });
      expect(booked.statusCode, booked.body).toBe(201);
      const appointments = await app.inject({
        method: "GET", url: `/api/appointments?localDate=${DAY}&days=1`,
        headers: { cookie: ownerCookie }
      });
      const appointment = (appointments.json() as { id: string; scheduledLocalStart: string }[])
        .find((row) => row.id === booked.json().id)!;
      const block = (await read({ localDate: DAY, days: 1 })).find((row) => row.id === blockId)!;
      expect(appointment.scheduledLocalStart.slice(0, 10))
        .toBe(block.scheduledLocalStart.slice(0, 10));
    });
  });

  describe("the window", () => {
    let insideId = "", beforeId = "", afterId = "", straddleId = "";
    let touchesOpenId = "", touchesCloseId = "";

    beforeAll(async () => {
      insideId = await created({
        localStart: `${DAY}T14:00`, localEnd: `${DAY}T14:30`, reason: "Inside the window"
      });
      beforeId = await created({
        localStart: `${DAY_BEFORE}T14:00`, localEnd: `${DAY_BEFORE}T14:30`, reason: "Before it"
      });
      afterId = await created({
        localStart: `${FAR_DAY}T14:00`, localEnd: `${FAR_DAY}T14:30`, reason: "After it"
      });
      // Starts the evening before the window opens and runs past midnight into it. THE CASE THAT
      // DECIDED THE PREDICATE: this region occupies the top of the window's first column, and a
      // start-keyed read would leave that stretch invisible - the very defect being fixed, one
      // column over.
      straddleId = await created({
        localStart: `${DAY_BEFORE}T23:00`, localEnd: `${DAY}T01:00`, reason: "Straddles the open"
      });
      // The two half-open boundaries, on the other groomer so they cannot be confused with the
      // straddle above. One ends exactly as the window opens; one starts exactly as it closes.
      touchesOpenId = await created({
        localStart: `${DAY_BEFORE}T22:00`, localEnd: `${DAY}T00:00`, reason: "Ends at the open",
        employeeId: secondEmployeeId
      });
      touchesCloseId = await created({
        localStart: `${DAY_AFTER}T00:00`, localEnd: `${DAY_AFTER}T00:30`,
        reason: "Starts at the close", employeeId: secondEmployeeId
      });
    });

    it("returns what overlaps the window and nothing that does not", async () => {
      const ids = (await read({ localDate: DAY, days: 1 })).map((row) => row.id);
      expect(ids).toContain(insideId);
      expect(ids).not.toContain(beforeId);
      expect(ids).not.toContain(afterId);
    });

    it("RETURNS a block that straddles the window's opening edge, with its own wall clock", async () => {
      // The deliberate decision, stated as an assertion rather than left to the reader. A block is
      // a region the grid paints, not a booking keyed by when it starts, so overlap is the
      // question and the answer is yes. Its wall clock is reported UNCLAMPED - the previous
      // evening's 23:00 - because clamping would tell the client the region begins at midnight
      // when it does not, and the client is the thing that decides which pixels to fill.
      const rows = await read({ localDate: DAY, days: 1 });
      const straddle = rows.find((row) => row.id === straddleId);
      expect(straddle, JSON.stringify(rows.map((row) => row.reason))).toBeDefined();
      expect(straddle).toMatchObject({
        scheduledLocalStart: `${DAY_BEFORE}T23:00`,
        scheduledLocalEnd: `${DAY}T01:00`
      });
    });

    it("treats both window edges as half-open, the way the appointments overlap read does", async () => {
      const ids = (await read({ localDate: DAY, days: 1 })).map((row) => row.id);
      // Ends at the instant the window opens: it occupies none of the window, so it is absent.
      expect(ids).not.toContain(touchesOpenId);
      // Begins at the instant the window closes: likewise, and it belongs to the NEXT day's paint.
      expect(ids).not.toContain(touchesCloseId);
      // Both are real rows that the right window does return, so the exclusions above are the
      // boundary rule and not a missing fixture.
      expect((await read({ localDate: DAY_BEFORE, days: 1 })).map((row) => row.id))
        .toContain(touchesOpenId);
      expect((await read({ localDate: DAY_AFTER, days: 1 })).map((row) => row.id))
        .toContain(touchesCloseId);
    });

    it("widens with days, and defaults to the same eight the calendar asks appointments for", async () => {
      const eight = (await read({ localDate: DAY_BEFORE, days: 8 })).map((row) => row.id);
      expect(eight).toEqual(expect.arrayContaining([beforeId, straddleId, insideId, touchesOpenId]));
      expect(eight).not.toContain(afterId);
      // No `days` at all is the same window as `days=8`, which is what the calendar sends.
      expect((await read({ localDate: DAY_BEFORE })).map((row) => row.id)).toEqual(eight);
    });

    it("filters by groomer with the same employeeIds the calendar filters appointments by", async () => {
      const mine = await read({ localDate: DAY, days: 1, employeeIds: employeeId });
      expect(mine.every((row) => row.employeeId === employeeId)).toBe(true);
      expect(mine.map((row) => row.id)).toContain(insideId);
      const theirs = await read({ localDate: DAY_BEFORE, days: 1, employeeIds: secondEmployeeId });
      expect(theirs.map((row) => row.id)).toContain(touchesOpenId);
      expect(theirs.map((row) => row.id)).not.toContain(straddleId);
    });
  });

  describe("whose blocks these are", () => {
    it("never returns another business's block, over any window", async () => {
      // The rival's block is at the SAME wall clock on the SAME date as this salon's, so a missing
      // tenant predicate would be invisible to a test that only counted rows.
      expect((await read({ localDate: DAY, days: 8 })).some((row) => row.reason === "Rival lunch"))
        .toBe(false);

      // Proven present on the other side of the boundary rather than assumed to exist.
      const theirs = await read({ localDate: DAY, days: 1 }, rivalCookie);
      expect(theirs.map((row) => row.reason)).toContain("Rival lunch");
      expect(theirs.some((row) => row.reason === "QA seed: Lunch")).toBe(false);

      const [count] = await db<{ count: number }[]>`
        select count(*)::int as count from blocked_times
        where business_id=${rivalBusinessId} and reason='Rival lunch'`;
      expect(count!.count).toBe(1);
    });

    it("scopes to the session's active location, exactly as the appointments calendar does", async () => {
      const elsewhere = await created({
        localStart: `${DAY}T15:00`, localEnd: `${DAY}T15:30`, reason: "Other shop lunch",
        locationId: otherLocationId
      });
      // Written against the second shop while the session is on the first, so the row exists and
      // is simply not this grid's business.
      const here = await read({ localDate: DAY, days: 1 });
      expect(here.map((row) => row.id)).not.toContain(elsewhere);
      expect(here.every((row) => row.locationId === locationId)).toBe(true);

      const switched = await setActiveLocation(otherLocationId);
      expect(switched.statusCode, switched.body).toBe(200);
      const there = await read({ localDate: DAY, days: 1 });
      expect(there.map((row) => row.id)).toContain(elsewhere);
      expect(there.every((row) => row.locationId === otherLocationId)).toBe(true);
      await setActiveLocation(locationId);
    });
  });

  describe("what a block outranks, and what outranks it", () => {
    const OVERRIDE_DAY = "2027-02-16";
    const BYPASS_DAY = "2027-02-23";

    it("survives a per-date availability row that would otherwise open the time", async () => {
      // STEP 5 IS SUBTRACTIVE, AND THIS IS WHAT THAT MEANS IN PRODUCT TERMS. A row in
      // `employee_date_availability` describes the GROOMER'S HOURS on one date; a block describes
      // time already spoken for. Widening the hours cannot un-speak-for it, so the subtraction
      // happens last and the refusal stands.
      const blockId = await created({
        localStart: `${OVERRIDE_DAY}T12:00`, localEnd: `${OVERRIDE_DAY}T13:00`, reason: "Immovable"
      });
      await db`
        delete from employee_date_availability
        where business_id=${businessId} and employee_id=${employeeId}
          and local_date=${OVERRIDE_DAY}::date`;
      await db`
        insert into employee_date_availability
          (business_id,employee_id,local_date,working,start_time,end_time)
        values (${businessId},${employeeId},${OVERRIDE_DAY}::date,true,'06:00','22:00')`;

      const refused = await book(`${OVERRIDE_DAY}T12:00`);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe("TIME_BLOCKED");
      // The widened hours ARE in force - 18:00 is outside the 09:00-17:00 weekday grid and books
      // only because the per-date row opened it - so the refusal above is the block and nothing
      // else. Without this the test would also pass on a per-date row that was simply ignored.
      const late = await book(`${OVERRIDE_DAY}T18:00`);
      expect(late.statusCode, late.body).toBe(201);

      // And it is still drawn, so the operator can see what refused them.
      expect((await read({ localDate: OVERRIDE_DAY, days: 1 })).find((row) => row.id === blockId))
        .toMatchObject({ scheduledLocalStart: `${OVERRIDE_DAY}T12:00`, reason: "Immovable" });
      await db`
        delete from employee_date_availability
        where business_id=${businessId} and employee_id=${employeeId}
          and local_date=${OVERRIDE_DAY}::date`;
    });

    it("is NOT bypassable by an explicit availabilityOverride, and says so in the refusal", async () => {
      // THIS CASE USED TO ASSERT THE OPPOSITE AND WAS REWRITTEN DELIBERATELY, not deleted. A block
      // was bypassable by the request flag for as long as the flag existed:
      // `availabilityOverrideMayBypass` returned true for `fully_blocked`, so a caller holding the
      // override permission could book straight over a lunch break and the block stayed
      // underneath, leaving the grid painting a region the scheduler had already sold. The product
      // decision is that an explicit block is HARD - the way past it is to move or delete it,
      // which is an attributable edit to the thing that is in the way.
      //
      // The whole point is observed from OUTSIDE, through the booking route, so a regression
      // surfaces as a failing product test and not only as a failing domain one.
      const blockId = await created({
        localStart: `${BYPASS_DAY}T12:00`, localEnd: `${BYPASS_DAY}T13:00`, reason: "Immovable too"
      });
      const refused = await book(`${BYPASS_DAY}T12:00`);
      expect(refused.statusCode, refused.body).toBe(409);
      // `canOverride: false` is half the contract. A client offering an override control here
      // would be offering a button the server refuses, so the refusal states that no flag helps -
      // and it says so to an OWNER, because the answer is about the rule, not about the caller.
      expect(refused.json()).toMatchObject({ code: "TIME_BLOCKED", canOverride: false });

      const forced = await book(`${BYPASS_DAY}T12:00`, {
        availabilityOverride: true, overrideReason: "Owner asked for it in person"
      });
      expect(forced.statusCode, forced.body).toBe(409);
      expect(forced.json()).toMatchObject({ code: "TIME_BLOCKED", canOverride: false });

      // THE DISTINCTION IS THE POINT, NOT A BLANKET HARDENING. 18:00 is past the 09:00-17:00
      // weekday grid, which is an ORDINARY-hours restriction, and the same flag on the same day
      // still clears it. Without this the case above would also pass on an override that had
      // simply stopped working.
      const outsideHours = await book(`${BYPASS_DAY}T18:00`);
      expect(outsideHours.statusCode, outsideHours.body).toBe(409);
      expect(outsideHours.json()).toMatchObject({ code: "OUTSIDE_STAFF_HOURS", canOverride: true });
      const late = await book(`${BYPASS_DAY}T18:00`, {
        availabilityOverride: true, overrideReason: "Owner asked for it in person"
      });
      expect(late.statusCode, late.body).toBe(201);

      // And the block is untouched by any of it - no route here consumes, clears or alters one.
      expect((await read({ localDate: BYPASS_DAY, days: 1 })).find((row) => row.id === blockId))
        .toMatchObject({
          scheduledLocalStart: `${BYPASS_DAY}T12:00`,
          scheduledLocalEnd: `${BYPASS_DAY}T13:00`,
          reason: "Immovable too"
        });
    });
  });

  describe("the shape of the answer", () => {
    it("reports a null reason as null rather than inventing a label", async () => {
      // `POST /api/blocked-times` requires a reason, but the column is nullable and has been since
      // 0001, so a row written before that route existed - or by a seed - can carry none. The
      // client has to render that case and needs to be told which case it is.
      const [row] = await db<{ id: string }[]>`
        insert into blocked_times(business_id,employee_id,location_id,start_at,end_at,
          scheduling_timezone,scheduled_local_start,scheduled_local_end,reason,created_by,updated_by)
        select ${businessId},${employeeId},${locationId},
          (${`${FAR_DAY} 09:00:00`}::timestamp at time zone 'America/Los_Angeles'),
          (${`${FAR_DAY} 09:30:00`}::timestamp at time zone 'America/Los_Angeles'),
          'America/Los_Angeles',
          (${`${FAR_DAY} 09:00:00`}::timestamp),(${`${FAR_DAY} 09:30:00`}::timestamp),
          -- updated_by is NOT NULL from 0056, and a row nobody has edited was last written by
          -- whoever wrote it, which is what that migration backfills every historical block with.
          null,user_id,user_id
        from business_memberships where business_id=${businessId} and is_owner returning id`;
      const found = (await read({ localDate: FAR_DAY, days: 1 }))
        .find((entry) => entry.id === row!.id);
      expect(found).toBeDefined();
      expect(found!.reason).toBeNull();
    });

    it("orders by start, so the client never has to sort a calendar layer", async () => {
      const starts = (await read({ localDate: DAY, days: 8 })).map((row) => row.startAt);
      expect(starts).toEqual([...starts].sort());
    });

    it("refuses a query it does not understand rather than silently widening the window", async () => {
      const malformed = await app.inject({
        method: "GET", url: "/api/blocked-times?localDate=not-a-date",
        headers: { cookie: ownerCookie }
      });
      expect(malformed.statusCode).toBe(400);
      const unknown = await app.inject({
        method: "GET", url: "/api/blocked-times?everything=true",
        headers: { cookie: ownerCookie }
      });
      expect(unknown.statusCode).toBe(400);
    });

    it("requires a session", async () => {
      expect((await app.inject({ method: "GET", url: "/api/blocked-times" })).statusCode).toBe(401);
    });
  });
});
