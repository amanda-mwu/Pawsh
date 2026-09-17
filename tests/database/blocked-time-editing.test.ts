import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissionPresets } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { createRole } from "../support/roles.js";

/**
 * A BLOCK BECOMES SOMETHING AN OPERATOR CAN CHANGE AND REMOVE.
 *
 * `blocked_times` has been enforceable since 0001 and unmanageable ever since: one write path, a
 * read path added in the seam before this one, and no way at all to correct a row once it existed.
 * `PATCH` and `DELETE` land here, and four things about them are each easy to get quietly wrong in
 * a way no compiler and no type would catch. They are pinned side by side rather than left to the
 * change that made them.
 *
 * 1. THE WALL CLOCK. `blocked_times` carries the authoritative instants AND a denormalised local
 *    pair, related by the row's own `scheduling_timezone` under migration 0051's check constraint.
 *    0051 exists because a write path bound an operator's local string straight into the naive
 *    column and the driver read it back in the API host's zone - a 12:30 booking persisted as
 *    19:30. An edit route has three ways to reintroduce that and one of them - rewriting the time
 *    columns during an edit that only changed a reason - silently MOVES a block.
 *
 * 2. CONCURRENCY. A block is a scheduling constraint: while it stands the availability authority
 *    refuses every booking that touches it. Last-write-wins leaves the loser's screen showing a
 *    constraint that is not there any more, and the bookings they take or refuse are then decided
 *    by a rule nobody is looking at. Both mutations take the version and both refuse a stale one.
 *
 * 3. WHAT A MUTATION RECORDS. `version`, `updated_at`, `updated_by` and the audit trail move
 *    together on a real change and none of them moves on a no-op.
 *
 * 4. SCHEDULING INTEGRITY. An edit has to reach the same authoritative constraint appointment
 *    creation consults, immediately, with no cached copy and no second code path - and it must not
 *    give anybody a way past `TIME_BLOCKED`, which stays HARD.
 *
 * EVERY TIME HERE IS AMERICA/LOS_ANGELES, following `blocked-time-visibility.test.ts` and
 * `blocked-time-management.test.ts`, and for their reason: a UTC salon cannot fail a wall-clock
 * case at all, because the host and the salon agree. The February dates are PST (UTC-8) and the
 * July ones are PDT (UTC-7), so a fixed-offset implementation passes one and fails the other.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "blocked-time-editing-secret-32-characters",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const sessionCookie = (response: { headers: Record<string, unknown> }) => {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
};

/** The wall-clock form a calendar column places: no seconds, no zone, never an instant. */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** PST, UTC-8. */
const WINTER = "2029-02-14";
/** PDT, UTC-7, so the offset is not a constant. */
const SUMMER = "2029-07-18";

interface BlockRow {
  id: string;
  employeeId: string;
  employeeName: string;
  locationId: string;
  reason: string | null;
  colorSlot: number | null;
  version: number;
  startAt: string;
  endAt: string;
  schedulingTimezone: string;
  scheduledLocalStart: string;
  scheduledLocalEnd: string;
}

interface ActivityItem {
  id: string;
  action: string;
  createdAt: string;
  actorName: string | null;
  reason: string | null;
  derived: boolean;
  fromEmployeeId: string | null;
  toEmployeeId: string | null;
  fromStartAt: string | null;
  toStartAt: string | null;
  fromEndAt: string | null;
  toEndAt: string | null;
  fromReason: string | null;
  toReason: string | null;
  fromColorSlot: number | null;
  toColorSlot: number | null;
  fromVersion: number | null;
  toVersion: number | null;
}

describeDatabase("editing and removing a blocked time", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string, rivalCookie: string;
  let businessId: string, locationId: string, driftLocationId: string;
  let ownerUserId: string;
  let employeeId: string, employeeName: string;
  let secondEmployeeId: string, secondEmployeeName: string;
  // A groomer nothing else in this file books or blocks, so the note cases can place a block on any
  // hour they like without a later booking landing on it or a refusal being ambiguous about why.
  let noteEmployeeId: string;
  let customerId: string, petId: string, serviceId: string;
  let rivalBlockId: string;
  const suffix = crypto.randomUUID().slice(0, 8);
  let seq = 0;

  const locationVersion = async (id: string) => {
    const [row] = await db<{ version: number }[]>`select version from locations where id=${id}`;
    return row!.version;
  };

  /** A member session holding exactly `permissions` and nothing else. */
  async function sessionWith(permissions: readonly string[]): Promise<string> {
    seq += 1;
    const email = `block-edit-role-${seq}-${suffix}@example.test`;
    const roleId = await createRole(app, ownerCookie, `Block edit role ${seq} ${suffix}`, permissions);
    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email, roleId }
    });
    expect(invitation.statusCode, invitation.body).toBe(201);
    const token = new URL(invitation.json().acceptancePath, "http://localhost")
      .searchParams.get("invite");
    const accepted = await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: "correct horse blocked editing" }
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    return sessionCookie(accepted);
  }

  /** The create route, exactly as an operator's block reaches it. */
  const blockTime = async (input: {
    localStart: string; localEnd: string; reason?: string; colorSlot?: number | null;
    employeeId?: string; locationId?: string; cookie?: string;
  }) => {
    const target = input.locationId ?? locationId;
    return app.inject({
      method: "POST", url: "/api/blocked-times", headers: { cookie: input.cookie ?? ownerCookie },
      payload: {
        employeeId: input.employeeId ?? employeeId, locationId: target,
        localStart: input.localStart, localEnd: input.localEnd,
        reason: input.reason ?? "Lunch",
        expectedLocationVersion: await locationVersion(target),
        ...(input.colorSlot === undefined ? {} : { colorSlot: input.colorSlot })
      }
    });
  };

  const created = async (input: Parameters<typeof blockTime>[0]): Promise<BlockRow> => {
    const response = await blockTime(input);
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as BlockRow;
  };

  const patch = (id: string, payload: Record<string, unknown>, cookie = ownerCookie) =>
    app.inject({ method: "PATCH", url: `/api/blocked-times/${id}`, headers: { cookie }, payload });

  const remove = (id: string, version: number, cookie = ownerCookie) =>
    app.inject({
      method: "DELETE", url: `/api/blocked-times/${id}?version=${version}`, headers: { cookie }
    });

  const activity = (id: string, cookie = ownerCookie) =>
    app.inject({ method: "GET", url: `/api/blocked-times/${id}/activity`, headers: { cookie } });

  /** The read route over one local day, so a PATCH's answer can be compared with a refetch. */
  const read = async (localDate: string) => {
    const response = await app.inject({
      method: "GET", url: `/api/blocked-times?localDate=${localDate}&days=1`,
      headers: { cookie: ownerCookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as BlockRow[];
  };

  /** What the row actually holds, read as TEXT so the driver cannot reinterpret the naive pair. */
  const stored = async (id: string) => {
    const [row] = await db<{
      version: number; schedulingTimezone: string; startAt: Date; endAt: Date;
      localStart: string; localEnd: string; updatedBy: string; createdBy: string;
      updatedAt: Date; createdAt: Date; employeeId: string; reason: string | null;
      colorSlot: number | null;
    }[]>`
      select version,scheduling_timezone,start_at,end_at,updated_by,created_by,updated_at,created_at,
        employee_id,reason,color_slot,
        to_char(scheduled_local_start,'YYYY-MM-DD"T"HH24:MI') as local_start,
        to_char(scheduled_local_end,'YYYY-MM-DD"T"HH24:MI') as local_end
      from blocked_times where id=${id}
    `;
    return row;
  };

  const auditRows = (id: string) =>
    db<{ action: string; beforeData: Record<string, unknown> | null;
      afterData: Record<string, unknown> | null }[]>`
      select action,before_data,after_data from audit_events
      where resource_type='blocked_time' and resource_id=${id}
      order by created_at,id
    `;

  const book = async (localStart: string, staffId = employeeId) =>
    app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId: staffId, serviceIds: [serviceId],
        localStart, expectedLocationVersion: await locationVersion(locationId)
      }
    });

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `block-editing-${suffix}@example.test`,
      password: "correct horse blocked editing", businessName: `Block Editing ${suffix}`
    }});
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = sessionCookie(signup);
    ({ businessId, locationId } = signup.json());
    // Set in SQL, which does not move the location version, and before any version is read.
    await db`update locations set timezone='America/Los_Angeles' where id=${locationId}`;
    const [owner] = await db<{ id: string }[]>`
      select user_id as id from business_memberships where business_id=${businessId} and is_owner
    `;
    ownerUserId = owner!.id;

    // A SECOND SHOP THAT WILL BE RE-ZONED PART WAY THROUGH. A stored block can carry an older
    // `scheduling_timezone` than its location carries today, and that is the exact state in which
    // an edit route can move a block nobody asked to move. It gets its own location so re-zoning it
    // disturbs nothing else in this suite.
    const [drift] = await db<{ id: string }[]>`
      insert into locations(business_id,name,address,timezone)
      values (${businessId},'Drift Shop','3 Drift Way','America/Los_Angeles') returning id
    `;
    driftLocationId = drift!.id;

    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
    serviceId = (await post("/api/services", {
      name: `Edit Groom ${suffix}`, baseDurationMinutes: 60, basePriceMinor: 7000
    })).json().id;
    employeeName = `Edith Editor ${suffix}`;
    employeeId = (await post("/api/employees", {
      displayName: employeeName, serviceIds: [serviceId]
    })).json().id;
    secondEmployeeName = `Mona Mover ${suffix}`;
    secondEmployeeId = (await post("/api/employees", {
      displayName: secondEmployeeName, serviceIds: [serviceId]
    })).json().id;
    noteEmployeeId = (await post("/api/employees", {
      displayName: `Nora Noteless ${suffix}`, serviceIds: [serviceId]
    })).json().id;
    customerId = (await post("/api/customers", {
      firstName: "Edit", lastName: "Client", preferredContactMethod: "none", emailAllowed: false
    })).json().id;
    petId = (await post("/api/pets", { customerId, name: "Edit Pet", species: "dog" })).json().id;

    // Nine to five every weekday for both groomers, so no fixture date lands in the unconfigured
    // fail-open branch and a refusal is never ambiguous about which step produced it.
    for (const staffId of [employeeId, secondEmployeeId, noteEmployeeId]) {
      for (let weekday = 0; weekday < 7; weekday += 1) {
        await db`
          insert into employee_working_hours(business_id,employee_id,weekday,start_time,end_time)
          values (${businessId},${staffId},${weekday},'09:00','17:00')
        `;
      }
    }

    // A rival tenant with its own block, so the cross-tenant cases test a real id rather than a
    // made-up one - a leak would be invisible to any assertion that only used a random uuid.
    const rival = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `block-edit-rival-${suffix}@example.test`,
      password: "correct horse rival editing", businessName: `Rival Editing ${suffix}`
    }});
    expect(rival.statusCode, rival.body).toBe(201);
    rivalCookie = sessionCookie(rival);
    const rivalLocationId = rival.json().locationId as string;
    await db`update locations set timezone='America/Los_Angeles' where id=${rivalLocationId}`;
    const rivalEmployeeId = (await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: rivalCookie },
      payload: { displayName: `Rival Groomer ${suffix}`, serviceIds: [] }
    })).json().id as string;
    rivalBlockId = (await created({
      localStart: `${WINTER}T12:00`, localEnd: `${WINTER}T12:30`, reason: "Rival lunch",
      employeeId: rivalEmployeeId, locationId: rivalLocationId, cookie: rivalCookie
    })).id;
  }, 90_000);

  afterAll(async () => { await app.close(); await db.end(); });

  // ---------------------------------------------------------------------------------------------
  describe("what the edit route answers with", () => {
    /**
     * THE CONTRACT, IN ONE ASSERTION, BECAUSE THE BLOCK DIALOG CODES AGAINST EXACTLY THIS.
     *
     * The edited block is painted onto the same grid as the blocks a refetch returns, so the two
     * answers must be one answer. This compares the WHOLE object rather than a chosen field: a
     * projection that drifts by one key between the routes is a client rendering a block it just
     * saved differently from the same block a second later.
     */
    it("returns exactly what the read route returns for the same block", async () => {
      const block = await created({
        localStart: `${WINTER}T09:00`, localEnd: `${WINTER}T09:30`, reason: "Before", colorSlot: 2
      });
      const response = await patch(block.id, {
        version: block.version,
        employeeId: secondEmployeeId,
        localStart: `${WINTER}T10:00`, localEnd: `${WINTER}T11:00`,
        expectedLocationVersion: await locationVersion(locationId),
        reason: "After", colorSlot: 5
      });
      expect(response.statusCode, response.body).toBe(200);
      const edited = response.json() as BlockRow;

      const fetched = (await read(WINTER)).find((row) => row.id === block.id);
      expect(fetched, "the edited block must be reachable through the read route").toBeDefined();
      expect(edited).toEqual(fetched);

      // And it is the full shape, stated once so a field silently dropped from BOTH routes cannot
      // pass the comparison above.
      expect(edited).toMatchObject({
        id: block.id,
        employeeId: secondEmployeeId, employeeName: secondEmployeeName,
        locationId, reason: "After", colorSlot: 5,
        version: block.version + 1,
        schedulingTimezone: "America/Los_Angeles",
        scheduledLocalStart: `${WINTER}T10:00`,
        scheduledLocalEnd: `${WINTER}T11:00`
      });
    });

    /**
     * `version` IS PART OF THE PROJECTION ON EVERY ROUTE THAT ANSWERS WITH A BLOCK.
     *
     * 0055 added the column and deliberately left it off the wire because no route consumed it.
     * Both mutations require it back, so a client that cannot read it cannot edit a block at all -
     * and it has to arrive by the same name from the create route, the read route and the edit
     * route, or a client that painted optimistically holds a token it cannot use.
     */
    it("carries the concurrency token on create, read and edit alike", async () => {
      const block = await created({
        localStart: `${WINTER}T13:00`, localEnd: `${WINTER}T13:30`, reason: "Token"
      });
      expect(block.version, "a block nobody has edited is at version 1").toBe(1);

      const listed = (await read(WINTER)).find((row) => row.id === block.id)!;
      expect(listed.version).toBe(1);

      const edited = (await patch(block.id, { version: 1, reason: "Token moved" })).json() as BlockRow;
      expect(edited.version).toBe(2);
      expect((await read(WINTER)).find((row) => row.id === block.id)!.version).toBe(2);
    });

    it("refuses a window that ends before it starts, and a half-stated move", async () => {
      const block = await created({
        localStart: `${WINTER}T14:00`, localEnd: `${WINTER}T14:30`, reason: "Bounds"
      });
      const backwards = await patch(block.id, {
        version: block.version, employeeId,
        localStart: `${WINTER}T15:00`, localEnd: `${WINTER}T14:00`,
        expectedLocationVersion: await locationVersion(locationId)
      });
      expect(backwards.statusCode, backwards.body).toBe(400);

      // A move is one decision - who and when together - so a partial schedule is refused rather
      // than merged with the stored row. A `localStart` alone would have to invent an end.
      const partial = await patch(block.id, {
        version: block.version, localStart: `${WINTER}T15:00`
      });
      expect(partial.statusCode, partial.body).toBe(400);

      // And an unknown key is a field the operator believes they changed and the server would
      // otherwise ignore in silence.
      const misspelled = await patch(block.id, { version: block.version, colourSlot: 3 });
      expect(misspelled.statusCode, misspelled.body).toBe(400);

      // Nothing above touched the row.
      expect((await stored(block.id))!.version).toBe(block.version);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("the salon's wall clock", () => {
    /**
     * A MOVE STATES THE SALON'S CLOCK AS TEXT, ON BOTH SIDES OF A DAYLIGHT-SAVING CHANGE.
     *
     * The local pair is written from the RESOLVED INSTANT in SQL, never bound from the operator's
     * submitted string: the string is what `resolveWallTime` has just interpreted, and binding it
     * back records a wall clock nothing checked against the zone. That is migration 0051's defect,
     * the one that printed a 10:00 groom as 17:00.
     */
    it("moves a block in PST and in PDT, and stores one wall clock either way", async () => {
      const winter = await created({
        localStart: `${WINTER}T09:00`, localEnd: `${WINTER}T09:30`, reason: "Winter move"
      });
      const movedWinter = (await patch(winter.id, {
        version: winter.version, employeeId,
        localStart: `${WINTER}T13:00`, localEnd: `${WINTER}T13:30`,
        expectedLocationVersion: await locationVersion(locationId)
      })).json() as BlockRow;

      expect(movedWinter.scheduledLocalStart).toMatch(WALL_CLOCK);
      expect(movedWinter.scheduledLocalStart).not.toContain("Z");
      expect(movedWinter.scheduledLocalStart).toBe(`${WINTER}T13:00`);
      // PST is UTC-8, so 13:00 at the salon is 21:00Z. 21:00 is what the defect returned in the
      // wall-clock field, which is why this pair is asserted together.
      expect(movedWinter.startAt).toBe(`${WINTER}T21:00:00.000Z`);
      expect(movedWinter.endAt).toBe(`${WINTER}T21:30:00.000Z`);

      // The same 13:00 in July is PDT, an hour off PST. A fixed-offset implementation passes the
      // case above and fails this one.
      const summer = await created({
        localStart: `${SUMMER}T09:00`, localEnd: `${SUMMER}T09:30`, reason: "Summer move"
      });
      const movedSummer = (await patch(summer.id, {
        version: summer.version, employeeId,
        localStart: `${SUMMER}T13:00`, localEnd: `${SUMMER}T13:30`,
        expectedLocationVersion: await locationVersion(locationId)
      })).json() as BlockRow;
      expect(movedSummer.scheduledLocalStart).toBe(`${SUMMER}T13:00`);
      expect(movedSummer.startAt).toBe(`${SUMMER}T20:00:00.000Z`);
      expect(movedSummer.endAt).toBe(`${SUMMER}T20:30:00.000Z`);

      // AND THE STORED COLUMNS AGREE WITH WHAT WAS RETURNED, on both rows. Read as TEXT for the
      // same reason the route returns text: comparing a `timestamp without time zone` as a Date is
      // the original bug.
      for (const block of [movedWinter, movedSummer]) {
        const row = (await stored(block.id))!;
        expect(row.localStart).toBe(block.scheduledLocalStart);
        expect(row.localEnd).toBe(block.scheduledLocalEnd);
        expect(row.schedulingTimezone).toBe("America/Los_Angeles");
      }
    });

    /**
     * THE HIGHEST-RISK CASE IN THE WHOLE SEAM, AND THE ONE NO TYPE CATCHES.
     *
     * A stored block may carry an OLDER `scheduling_timezone` than its location carries today.
     * An edit route that rewrites every column on every PATCH would then, on an edit that changed
     * only a reason, resolve the block's wall clock in the CURRENT zone and move it - or write a
     * local pair that no longer matches the stored timezone, which 0051's check constraint refuses
     * outright and which reaches the operator as "violates a data integrity rule".
     *
     * So a metadata-only PATCH must not name a time column at all. This re-zones a whole shop
     * underneath a block and then edits nothing but the reason.
     */
    it("does not move a block whose stored timezone is older than its location's", async () => {
      const block = await created({
        localStart: `${WINTER}T12:00`, localEnd: `${WINTER}T12:30`,
        reason: "Before the move", locationId: driftLocationId
      });
      expect(block.startAt).toBe(`${WINTER}T20:00:00.000Z`);
      expect(block.schedulingTimezone).toBe("America/Los_Angeles");

      // The shop moves across the country. The block keeps the zone it was written in, which is
      // the state 0051's constraint is defined over.
      await db`update locations set timezone='America/New_York' where id=${driftLocationId}`;

      const renamed = (await patch(block.id, {
        version: block.version, reason: "After the move", colorSlot: 7
      })).json() as BlockRow;

      // NOTHING ABOUT WHEN IT IS CHANGED. Not the instants, not the timezone, not the wall clock.
      expect(renamed.startAt).toBe(block.startAt);
      expect(renamed.endAt).toBe(block.endAt);
      expect(renamed.schedulingTimezone).toBe("America/Los_Angeles");
      expect(renamed.scheduledLocalStart).toBe(`${WINTER}T12:00`);
      expect(renamed.scheduledLocalEnd).toBe(`${WINTER}T12:30`);
      expect(renamed.reason).toBe("After the move");
      expect(renamed.colorSlot).toBe(7);

      const row = (await stored(block.id))!;
      expect(row.startAt.toISOString()).toBe(block.startAt);
      expect(row.schedulingTimezone).toBe("America/Los_Angeles");
      expect(row.localStart).toBe(`${WINTER}T12:00`);

      /**
       * AND WHEN THE MOVE IS ACTUALLY REQUESTED, THE CURRENT ZONE IS THE RIGHT ANSWER. The operator
       * is looking at a dialog showing this shop's clock, so 12:00 means 12:00 in the zone the shop
       * is in NOW - and the timezone and both local columns move with the instants in one
       * statement, which is what keeps 0051's constraint satisfied.
       */
      const rescheduled = (await patch(block.id, {
        version: renamed.version, employeeId,
        localStart: `${WINTER}T12:00`, localEnd: `${WINTER}T12:30`,
        expectedLocationVersion: await locationVersion(driftLocationId)
      })).json() as BlockRow;
      expect(rescheduled.schedulingTimezone).toBe("America/New_York");
      // EST is UTC-5, so the same 12:00 is now 17:00Z rather than 20:00Z.
      expect(rescheduled.startAt).toBe(`${WINTER}T17:00:00.000Z`);
      expect(rescheduled.scheduledLocalStart).toBe(`${WINTER}T12:00`);
      const after = (await stored(block.id))!;
      expect(after.schedulingTimezone).toBe("America/New_York");
      expect(after.localStart).toBe(`${WINTER}T12:00`);

      // Put the shop back, so nothing later in the file inherits a re-zoned location.
      await db`update locations set timezone='America/Los_Angeles' where id=${driftLocationId}`;
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("concurrency", () => {
    /**
     * A STALE EDIT IS REFUSED RATHER THAN SILENTLY APPLIED, and the refusal is the same 409 shape
     * `PATCH /api/appointments/:id/schedule` answers with for a stale appointment. Two managers
     * with the same block open - one shortening it, one moving it to Wednesday - resolved by
     * whoever clicks last leaves the loser's screen showing a constraint that is not there.
     */
    it("refuses a PATCH that carries a version somebody has already superseded", async () => {
      const block = await created({
        localStart: `${SUMMER}T09:00`, localEnd: `${SUMMER}T09:30`, reason: "First"
      });
      const first = (await patch(block.id, { version: block.version, reason: "Second" }))
        .json() as BlockRow;
      expect(first.version).toBe(2);

      const stale = await patch(block.id, { version: block.version, reason: "Third" });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toMatchObject({ code: "STALE_BLOCKED_TIME" });
      expect(stale.json().error).toMatch(/refresh/iu);

      // And the refused write changed nothing.
      const row = (await stored(block.id))!;
      expect(row.version).toBe(2);
      expect(row.reason).toBe("Second");
    });

    /**
     * DELETE IS CONCURRENCY-AWARE TOO, and it is the more dangerous of the two: the block somebody
     * is removing may have been moved onto a different hour since they last looked, and a
     * last-write-wins delete takes away a constraint the deleter never saw.
     */
    it("refuses a DELETE that carries a superseded version, and keeps the block", async () => {
      const block = await created({
        localStart: `${SUMMER}T10:00`, localEnd: `${SUMMER}T10:30`, reason: "Doomed"
      });
      await patch(block.id, {
        version: block.version, employeeId,
        localStart: `${SUMMER}T11:00`, localEnd: `${SUMMER}T11:30`,
        expectedLocationVersion: await locationVersion(locationId)
      });

      const stale = await remove(block.id, block.version);
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toMatchObject({ code: "STALE_BLOCKED_TIME" });
      expect((await stored(block.id)), "the block survives a stale delete").toBeDefined();

      // The current version does remove it.
      const removed = await remove(block.id, 2);
      expect(removed.statusCode, removed.body).toBe(204);
      expect(await stored(block.id)).toBeUndefined();
    });

    it("moves the version exactly one step per successful mutation", async () => {
      const block = await created({
        localStart: `${SUMMER}T12:00`, localEnd: `${SUMMER}T12:30`, reason: "Counting"
      });
      let version = block.version;
      for (const reason of ["One", "Two", "Three"]) {
        const response = await patch(block.id, { version, reason });
        expect(response.statusCode, response.body).toBe(200);
        version = (response.json() as BlockRow).version;
      }
      expect(version).toBe(4);
      expect((await stored(block.id))!.version).toBe(4);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("what a mutation records", () => {
    it("stamps the last writer and the moment on a real change", async () => {
      const editor = await sessionWith(permissionPresets.manager!);
      const block = await created({
        localStart: `${SUMMER}T13:00`, localEnd: `${SUMMER}T13:30`, reason: "Stamped"
      });
      const before = (await stored(block.id))!;
      // A block written once was last written by its author, at the moment it was created.
      expect(before.updatedBy).toBe(before.createdBy);
      expect(before.updatedBy).toBe(ownerUserId);
      expect(before.updatedAt.toISOString()).toBe(before.createdAt.toISOString());

      const edited = await patch(block.id, { version: block.version, reason: "Restamped" }, editor);
      expect(edited.statusCode, edited.body).toBe(200);
      const after = (await stored(block.id))!;
      expect(after.updatedBy, "the last writer is the person who saved").not.toBe(before.updatedBy);
      expect(after.createdBy, "the author never changes").toBe(before.createdBy);
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
    });

    /**
     * A PATCH THAT CHANGES NOTHING IS A NO-OP. THIS IS A DECISION, NOT AN ACCIDENT.
     *
     * `version` exists to tell a holder their copy is stale; moving it for a write that changed no
     * field makes that statement false and invalidates every other open editor so they can refetch
     * a row identical to the one they already had. And the activity feed is a record of what
     * happened - "nothing happened" is noise that pushes real edits past the read's limit. A dialog
     * that saves on close would write one of these every time somebody opened a block to look at it.
     *
     * All four are pinned: `version`, `updated_at`, `updated_by` and the audit trail. The response
     * is still the current projection, and the version in it has not moved, which is the truth.
     */
    it("leaves the version, the stamps and the trail alone when nothing changed", async () => {
      const editor = await sessionWith(permissionPresets.manager!);
      const block = await created({
        localStart: `${SUMMER}T14:00`, localEnd: `${SUMMER}T14:30`, reason: "Unchanged", colorSlot: 3
      });
      const before = (await stored(block.id))!;
      const trailBefore = await auditRows(block.id);

      // Three shapes of "nothing changed", each of which a real client sends: the empty save, the
      // same metadata re-sent, and a dialog re-submitting the block's own groomer and hours.
      const noOps: Record<string, unknown>[] = [
        { version: block.version },
        { version: block.version, reason: "Unchanged", colorSlot: 3 },
        {
          version: block.version, employeeId,
          localStart: `${SUMMER}T14:00`, localEnd: `${SUMMER}T14:30`,
          expectedLocationVersion: await locationVersion(locationId),
          reason: "Unchanged", colorSlot: 3
        }
      ];
      for (const payload of noOps) {
        const response = await patch(block.id, payload, editor);
        expect(response.statusCode, response.body).toBe(200);
        const answered = response.json() as BlockRow;
        // The answer is the block as it stands, and the version in it has not moved.
        expect(answered.version).toBe(block.version);
        expect(answered).toEqual({ ...block, version: block.version });
      }

      const after = (await stored(block.id))!;
      expect(after.version).toBe(before.version);
      expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
      expect(after.updatedBy).toBe(before.updatedBy);
      expect(await auditRows(block.id)).toEqual(trailBefore);
    });

    /**
     * THE VERSION IS CHECKED BEFORE THE NO-OP TEST, so a 409 means one thing and only one thing:
     * your copy is stale. A stale caller who happens to be re-sending values that match what is
     * stored is still a caller looking at a block that has moved on since.
     */
    it("still refuses a stale version even when the request would have changed nothing", async () => {
      const block = await created({
        localStart: `${SUMMER}T15:00`, localEnd: `${SUMMER}T15:30`, reason: "Stale no-op"
      });
      await patch(block.id, { version: block.version, reason: "Moved on" });
      const response = await patch(block.id, { version: block.version, reason: "Moved on" });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ code: "STALE_BLOCKED_TIME" });
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * TAKING A BLOCK'S NOTE BACK OFF IT.
   *
   * `blocked_times.reason` has been nullable since 0001 and the edit body had no way to say so:
   * `reason` was `.optional()` over a `min(1)` string, so a note could be changed and never
   * removed. An operator who blocked out an afternoon and typed the wrong label into it was stuck
   * with the label, and the dialog had to mark the field required to describe that honestly.
   *
   * THE CONTRACT IS THREE STATES AND THE WIRE CAN TELL THEM APART.
   *
   *   absent   - leave the note exactly as it is. Today's behaviour, and the regression below
   *              exists because it is the one that breaks if a clear is implemented carelessly:
   *              `input.reason ?? current.reason` is correct for `undefined` and WRONG for `null`,
   *              and the two look identical at a glance.
   *   null     - clear it. A real change: version, stamps and one audit row with a genuine delta.
   *   "text"   - set it, trimmed, 1-500, exactly as the create route bounds it.
   *   "" / "  " - REFUSED, 400. An empty text input is a field somebody has not filled in yet, not
   *              an instruction to delete anything. `null` is the one way to clear, and a client
   *              has to mean it.
   *
   * And a clear is not a special case in the route: `null` flows into the same comparison every
   * other metadata edit flows into, so clearing a note that is ALREADY null is the no-op this
   * route already promises rather than a version bump nobody asked for.
   */
  describe("clearing a block's note", () => {
    /**
     * THE REGRESSION, FIRST. Omitting `reason` means "I am not editing the note" and has meant that
     * since the edit route landed. It is asserted alongside a colour edit that DID change, so the
     * case cannot pass by the PATCH being rejected or turning into a no-op.
     */
    it("leaves the note alone when reason is absent from the body", async () => {
      const block = await created({
        localStart: `${SUMMER}T08:00`, localEnd: `${SUMMER}T08:30`, reason: "Keep me",
        employeeId: noteEmployeeId, colorSlot: 1
      });
      const response = await patch(block.id, { version: block.version, colorSlot: 6 });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        reason: "Keep me", colorSlot: 6, version: block.version + 1
      });
      expect((await stored(block.id))!.reason).toBe("Keep me");
    });

    /**
     * AN EXPLICIT NULL CLEARS IT, AND EVERY WITNESS AGREES.
     *
     * The answer, a refetch through the calendar read, and the stored row are all checked, because
     * a clear that only reached the projection - or only reached the column - is a block that
     * renders one way and reloads another.
     */
    it("clears the note when reason is explicitly null", async () => {
      const editor = await sessionWith(permissionPresets.manager!);
      const block = await created({
        localStart: `${SUMMER}T09:00`, localEnd: `${SUMMER}T09:30`, reason: "Typed by mistake",
        employeeId: noteEmployeeId
      });
      const before = (await stored(block.id))!;

      const response = await patch(block.id, { version: block.version, reason: null }, editor);
      expect(response.statusCode, response.body).toBe(200);
      const cleared = response.json() as BlockRow;
      expect(cleared.reason).toBeNull();

      // The calendar read is the second opinion, and it is the one the grid actually draws from.
      const fetched = (await read(SUMMER)).find((row) => row.id === block.id);
      expect(fetched, "the cleared block must still be reachable through the read route").toBeDefined();
      expect(fetched).toEqual(cleared);

      // A CLEAR IS A REAL CHANGE: one step of the version, and both stamps moved.
      const after = (await stored(block.id))!;
      expect(after.reason).toBeNull();
      expect(after.version, "exactly one step, not two").toBe(before.version + 1);
      expect(cleared.version).toBe(after.version);
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      expect(after.updatedBy, "the last writer is the person who cleared it").not.toBe(before.updatedBy);
      expect(after.createdBy, "the author never changes").toBe(before.createdBy);

      // And the note can be written back afterwards, so clearing is not a one-way door.
      const relabelled = await patch(block.id, { version: after.version, reason: "  Rewritten  " });
      expect(relabelled.statusCode, relabelled.body).toBe(200);
      // Trimmed on the way in, exactly as the create route trims.
      expect((relabelled.json() as BlockRow).reason).toBe("Rewritten");
    });

    /**
     * THE ACTIVITY FEED CARRIES A REAL EVENT WITH A REAL DELTA, not a synthesised one. `fromReason`
     * is what the note said and `toReason` is null, which is the whole content of "somebody removed
     * the label" - and `derived: false` says it was read from `audit_events` rather than
     * reconstructed from the row's own columns the way a pre-trail block's Created entry is.
     */
    it("records the clear as one real event with the old note and a null new one", async () => {
      const block = await created({
        localStart: `${SUMMER}T10:00`, localEnd: `${SUMMER}T10:30`, reason: "About to go",
        employeeId: noteEmployeeId
      });
      const trailBefore = await auditRows(block.id);
      expect((await patch(block.id, { version: block.version, reason: null })).statusCode).toBe(200);

      const trailAfter = await auditRows(block.id);
      expect(trailAfter.length, "one row, not two and not zero").toBe(trailBefore.length + 1);
      expect(trailAfter.at(-1)!.action).toBe("blocked_time.update");
      expect(trailAfter.at(-1)!.beforeData).toMatchObject({ reason: "About to go" });
      expect(trailAfter.at(-1)!.afterData).toMatchObject({ reason: null });

      const feed = await activity(block.id);
      expect(feed.statusCode, feed.body).toBe(200);
      const items = feed.json().items as ActivityItem[];
      const updates = items.filter((item) => item.action === "blocked_time.update");
      expect(updates.length).toBe(1);
      expect(updates[0]).toMatchObject({
        fromReason: "About to go", toReason: null, derived: false
      });
    });

    /**
     * CLEARING A NOTE THAT IS ALREADY GONE IS A NO-OP, on the same terms every other unchanged
     * PATCH is one: "unchanged" is measured against what is STORED, never against which fields the
     * request carried. A dialog whose note box is empty posts `reason: null` on every save; if that
     * bumped the version it would invalidate every other open editor for a change that did not
     * happen, and write a history entry saying so.
     */
    it("treats clearing an already-null note as a no-op", async () => {
      const block = await created({
        localStart: `${SUMMER}T11:00`, localEnd: `${SUMMER}T11:30`, reason: "Cleared once",
        employeeId: noteEmployeeId, colorSlot: 2
      });
      const firstClear = await patch(block.id, { version: block.version, reason: null });
      expect(firstClear.statusCode, firstClear.body).toBe(200);
      const emptied = firstClear.json() as BlockRow;
      expect(emptied.reason).toBeNull();

      const before = (await stored(block.id))!;
      const trailBefore = await auditRows(block.id);

      // Both shapes of "the note is already empty": the explicit clear a dialog sends every save,
      // and the same clear alongside a colour that is also unchanged.
      for (const payload of [
        { version: emptied.version, reason: null },
        { version: emptied.version, reason: null, colorSlot: 2 }
      ]) {
        const response = await patch(block.id, payload);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual(emptied);
      }

      const after = (await stored(block.id))!;
      expect(after.version, "no second step").toBe(before.version);
      expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
      expect(after.updatedBy).toBe(before.updatedBy);
      expect(await auditRows(block.id)).toEqual(trailBefore);
    });

    /**
     * AN EMPTY OR BLANK STRING IS NOT A COVERT CLEAR. `.trim()` runs before `.min(1)`, so
     * whitespace collapses to empty and fails the same check the create route applies. The block is
     * left exactly as it was - a 400 must not be a half-applied write.
     */
    it("refuses an empty or whitespace-only reason instead of reading it as a clear", async () => {
      const block = await created({
        localStart: `${SUMMER}T12:00`, localEnd: `${SUMMER}T12:30`, reason: "Still here",
        employeeId: noteEmployeeId
      });
      const before = (await stored(block.id))!;
      for (const blank of ["", " ", "   \t \n "]) {
        const response = await patch(block.id, { version: block.version, reason: blank });
        expect(response.statusCode, `reason ${JSON.stringify(blank)}`).toBe(400);
      }
      const after = (await stored(block.id))!;
      expect(after.reason).toBe("Still here");
      expect(after.version).toBe(before.version);
      expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
      expect(await auditRows(block.id)).toHaveLength(1);
    });

    /**
     * A NOTE-CLEAR ON A MULTI-DAY BLOCK LEAVES ALL FIVE TIME COLUMNS BYTE FOR BYTE.
     *
     * This is the block the edit dialog deliberately refuses to reschedule - a single-date control
     * cannot express a window that opens on one day and closes on another - while leaving its note
     * editable. The metadata branch is therefore the ONLY way such a block is ever written, and a
     * clear that recomputed, rounded or truncated a time column would turn a week-long holiday into
     * something else with nothing in the UI having asked for it.
     *
     * It spans 2029-03-11, the day Pacific time loses an hour: 32 hours of wall clock and 31 of
     * elapsed time, so an implementation that rebuilds the instants from the local pair - or the
     * pair from the instants - in the wrong zone lands an hour out here and nowhere else. Every
     * column is read as TEXT so the driver cannot reinterpret the naive pair on its way back, which
     * is the exact defect migration 0051 exists for.
     */
    it("leaves a multi-day block's five time columns untouched through a note-clear", async () => {
      const block = await created({
        localStart: "2029-03-10T22:00", localEnd: "2029-03-12T06:00",
        reason: "Week off", employeeId: noteEmployeeId
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

      const response = await patch(block.id, { version: block.version, reason: null });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ reason: null, version: block.version + 1 });

      expect(await times()).toEqual(before);
    });

    /**
     * A NOTE-CLEAR IS NOT A MOVE, SO THE APPOINTMENT GUARD NEVER RUNS.
     *
     * The block here sits on top of a booked appointment - a legacy state that predates the guard,
     * manufactured in SQL because the API is now exactly what refuses to manufacture it. The
     * interval is identical before and after a note edit, so there is nothing for the guard to
     * decide and no scheduling lock to take. If this ever starts answering 409, an operator can no
     * longer take a wrong label off a block they need to keep.
     */
    it("does not run the appointment guard for a note-clear over a booked appointment", async () => {
      const block = await created({
        localStart: `${SUMMER}T15:00`, localEnd: `${SUMMER}T16:00`, reason: "Legacy overlap",
        employeeId: noteEmployeeId
      });
      // Booked at an hour this describe leaves free - the API refuses a booking onto a block, so
      // the overlap has to be manufactured afterwards rather than booked into place.
      const booked = await book(`${SUMMER}T13:00`, noteEmployeeId);
      expect(booked.statusCode, booked.body).toBe(201);
      const appointmentId = booked.json().id as string;
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

      const response = await patch(block.id, { version: block.version, reason: null });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ reason: null });

      // The interval did not move, which is the reason the guard had nothing to say.
      const after = (await stored(block.id))!;
      expect(after.startAt.toISOString()).toBe(block.startAt);
      expect(after.endAt.toISOString()).toBe(block.endAt);
      expect(after.localStart).toBe(`${SUMMER}T15:00`);
      expect(after.localEnd).toBe(`${SUMMER}T16:00`);
      expect(after.schedulingTimezone).toBe(block.schedulingTimezone);

      // Put the appointment back out of the way so nothing later reads a row this case corrupted.
      const cancelled = await app.inject({
        method: "POST", url: `/api/appointments/${appointmentId}/transition`,
        headers: { cookie: ownerCookie }, payload: { status: "cancelled", reason: "Fixture" }
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
    });

    /**
     * CLEARING A NOTE IS EDITING A BLOCK, so it is gated on `calendar.blocks_edit` like every other
     * edit and nothing about a null opens a second door. A member without the key is refused
     * before the body is even considered, and a Groomer - who holds the key scoped to their own
     * calendar - is refused another groomer's block on scope.
     */
    it("still requires calendar.blocks_edit, and refuses a Groomer another groomer's block", async () => {
      const block = await created({
        localStart: `${SUMMER}T16:00`, localEnd: `${SUMMER}T16:30`, reason: "Gated",
        employeeId: noteEmployeeId
      });
      const createOnly = await sessionWith(["calendar.view", "calendar.blocks_create"]);
      const refused = await patch(block.id, { version: block.version, reason: null }, createOnly);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toContain("calendar.blocks_edit");
      expect((await stored(block.id))!.reason, "a refused clear writes nothing").toBe("Gated");

      const groomer = await sessionWith(permissionPresets.groomer!);
      const scoped = await patch(block.id, { version: block.version, reason: null }, groomer);
      expect(scoped.statusCode, scoped.body).toBe(403);
      expect(scoped.json().code).toBe("NOT_ASSIGNED_TO_YOU");
      expect((await stored(block.id))!.reason, "a refused clear writes nothing").toBe("Gated");

      // Holds the key and, having no employee record, the all-staff key that lets it reach a
      // block on somebody else's calendar.
      const editOnly = await sessionWith([
        "calendar.view", "calendar.blocks_edit", "appointments.edit_all_staff"
      ]);
      const allowed = await patch(block.id, { version: block.version, reason: null }, editOnly);
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect((allowed.json() as BlockRow).reason).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------------
  /**
   * THE NOTE ON A BLOCK BEING CREATED, WHICH IS THE OTHER HALF OF THE CONTRACT ABOVE.
   *
   * `PATCH` has been able to clear a note since the edit route landed, and `POST` still required
   * one - `reason` was a bare `min(1)` string. So `reason IS NULL` was a state a block could only
   * ARRIVE at, never be BORN in: an operator with nothing to add had to type a label and then
   * delete it, and every no-note block in the database carried a pointless second audit row saying
   * so. The column has been nullable since 0001, the read and detail projections have reported it
   * as nullable throughout, and the calendar already draws an unlabelled band as its time range
   * alone - the create body was the only thing insisting otherwise, so it is the only thing that
   * changed. No migration: nothing about the column moved.
   *
   * THE CREATE CONTRACT IS FOUR INPUTS AND TWO ANSWERS.
   *
   *   absent    - no note. Stored as SQL NULL.
   *   null      - no note. Stored as SQL NULL, and the SAME request as absent, because a create
   *               has no third case: there is nothing already stored to leave alone. That is the
   *               one place this differs from the edit, where absent means "do not touch it" and
   *               `Object.hasOwn` has to tell the two apart.
   *   "text"    - set it, trimmed, 1-500.
   *   "" / "  " - REFUSED, 400, and specifically NOT quietly read as "no note". A blank text input
   *               is a field somebody has not filled in yet; a create that coerced it to null
   *               would make an unsaved dialog and a decision the same request, and would hide the
   *               difference from the operator on the one route where it can still be corrected
   *               before anything is written. `null` is the one way to say it, on both routes.
   *
   * Every case reads back through the calendar read AND through the row, because a note that only
   * reached the response is a block that renders one way and reloads another.
   */
  describe("creating a block with no note", () => {
    /**
     * The create route with the note stated EXACTLY as the case gives it and no default in the
     * way, which is what makes "the key was never sent" reachable at all - the shared `blockTime`
     * helper substitutes "Lunch" for an absent reason, so it cannot express this.
     */
    const createWithNote = async (
      localStart: string, localEnd: string, note: Record<string, unknown>
    ) => app.inject({
      method: "POST", url: "/api/blocked-times", headers: { cookie: ownerCookie },
      payload: {
        employeeId: noteEmployeeId, locationId, localStart, localEnd,
        expectedLocationVersion: await locationVersion(locationId),
        ...note
      }
    });

    /** Whether the stored column is SQL NULL, asked in SQL - not "the driver handed me null". */
    const storedReasonIsNull = async (id: string) => {
      const [row] = await db<{ isNull: boolean }[]>`
        select reason is null as is_null from blocked_times where id=${id}
      `;
      return row!.isNull;
    };

    /** How many blocks this describe's groomer holds, so a 400 can be shown to have written none. */
    const blockCount = async () => {
      const [row] = await db<{ count: number }[]>`
        select count(*)::int as count from blocked_times where employee_id=${noteEmployeeId}
      `;
      return row!.count;
    };

    /**
     * OMITTING THE KEY AND SENDING NULL ARE ONE REQUEST, asserted as one case so the two answers
     * are compared against each other rather than each against a written expectation. A client
     * that drops an empty field and a client that sends `reason: null` are the same dialog with
     * two serialisers, and nothing downstream may be able to tell them apart.
     */
    it("stores no note when reason is omitted, and the same when it is explicitly null", async () => {
      const omitted = await createWithNote(`${WINTER}T05:00`, `${WINTER}T05:30`, {});
      expect(omitted.statusCode, omitted.body).toBe(201);
      const withoutKey = omitted.json() as BlockRow;
      expect(withoutKey.reason).toBeNull();

      const explicit = await createWithNote(`${WINTER}T05:30`, `${WINTER}T06:00`, { reason: null });
      expect(explicit.statusCode, explicit.body).toBe(201);
      const withNull = explicit.json() as BlockRow;
      expect(withNull.reason).toBeNull();

      // The two answers differ only in the fields that genuinely differ - identity and the hours.
      // Compared as whole objects with those blanked, so a route that started reporting one of
      // them as `""`, or as an absent key, while the other stayed null could not pass.
      const shape = (row: BlockRow) => ({
        ...row, id: null, startAt: null, endAt: null,
        scheduledLocalStart: null, scheduledLocalEnd: null
      });
      expect(shape(withoutKey)).toEqual(shape(withNull));

      for (const block of [withoutKey, withNull]) {
        // SQL NULL, not the string "null" and not the empty string.
        expect(await storedReasonIsNull(block.id), `stored reason for ${block.id}`).toBe(true);
        expect((await stored(block.id))!.reason).toBeNull();
        // And the calendar read - the projection the grid actually draws from - agrees with the
        // answer the create route gave, which is the whole promise the create response makes.
        const fetched = (await read(WINTER)).find((row) => row.id === block.id);
        expect(fetched, "a no-note block must be reachable through the read route").toBeDefined();
        expect(fetched).toEqual(block);
        expect(fetched!.reason).toBeNull();
      }
    });

    /**
     * AN EMPTY OR BLANK NOTE IS STILL A 400 ON CREATE, exactly as it is on edit, and the count
     * either side proves the refusal is a refusal rather than a write with a null in it. This is
     * the assertion the whole change turns on: making the note optional must not turn the empty
     * string into a second spelling of "no note".
     */
    it("refuses an empty or whitespace-only reason instead of storing no note", async () => {
      const before = await blockCount();
      for (const blank of ["", " ", "   \t \n "]) {
        const response = await createWithNote(
          `${WINTER}T06:00`, `${WINTER}T06:30`, { reason: blank }
        );
        expect(response.statusCode, `reason ${JSON.stringify(blank)}: ${response.body}`).toBe(400);
      }
      expect(await blockCount(), "a refused create writes nothing").toBe(before);
    });

    /**
     * THE REGRESSION. A note that IS given is still trimmed and still stored, so the field going
     * optional did not quietly stop it being read, and the bounds did not move: 500 characters is
     * still accepted and 501 is still refused.
     */
    it("still trims and stores a note that is given, on the same bounds as before", async () => {
      const response = await createWithNote(
        `${WINTER}T06:30`, `${WINTER}T07:00`, { reason: "  Staff meeting  " }
      );
      expect(response.statusCode, response.body).toBe(201);
      const block = response.json() as BlockRow;
      expect(block.reason).toBe("Staff meeting");
      expect((await stored(block.id))!.reason).toBe("Staff meeting");

      const atTheLimit = await createWithNote(
        `${WINTER}T07:00`, `${WINTER}T07:30`, { reason: "n".repeat(500) }
      );
      expect(atTheLimit.statusCode, "500 characters is the bound, not one past it").toBe(201);
      const overTheLimit = await createWithNote(
        `${WINTER}T07:30`, `${WINTER}T08:00`, { reason: "n".repeat(501) }
      );
      expect(overTheLimit.statusCode, overTheLimit.body).toBe(400);
    });

    /**
     * THE BLOCK'S OWN HISTORY STARTS CORRECTLY FOR A BLOCK THAT NEVER HAD A NOTE.
     *
     * `blocked_time.create` is written from the resolved values rather than from the request body,
     * so an absent key has to reach the payload as an explicit `null` - not as a missing key and
     * not as `undefined`, which would disappear on the way into JSON and leave the activity feed
     * reading back "no information" where the truth is "no note". One row, and `toReason` null in
     * the feed the drawer renders.
     */
    it("records the creation of a no-note block with a null reason", async () => {
      const response = await createWithNote(`${WINTER}T08:00`, `${WINTER}T08:30`, {});
      expect(response.statusCode, response.body).toBe(201);
      const block = response.json() as BlockRow;

      const rows = await auditRows(block.id);
      expect(rows.map((row) => row.action)).toEqual(["blocked_time.create"]);
      expect(rows[0]!.beforeData, "a create has no before").toBeNull();
      // The KEY has to be there carrying null. `toHaveProperty` says that where a subset match on
      // `{ reason: null }` would also pass against a payload that dropped the field entirely.
      expect(Object.keys(rows[0]!.afterData ?? {})).toContain("reason");
      expect(rows[0]!.afterData).toMatchObject({
        reason: null, employeeId: noteEmployeeId, version: 1
      });

      const feed = await activity(block.id);
      expect(feed.statusCode, feed.body).toBe(200);
      const items = feed.json().items as ActivityItem[];
      const creates = items.filter((item) => item.action === "blocked_time.create");
      expect(creates.length, "one Created entry, and a real one").toBe(1);
      expect(creates[0]).toMatchObject({ toReason: null, derived: false });
    });

    /**
     * AND THE TWO ROUTES MEET: a block born without a note takes one through the edit route and
     * gives it back, on the same version ladder every other edit walks. This is what closes the
     * asymmetry rather than merely widening the create - unlabelled is a state a block can now
     * enter, leave and re-enter, in either order, with no route treating it as special.
     */
    it("lets a block created with no note gain one and lose it again", async () => {
      const response = await createWithNote(`${WINTER}T08:30`, `${WINTER}T09:00`, { reason: null });
      expect(response.statusCode, response.body).toBe(201);
      const block = response.json() as BlockRow;
      expect(block.version, "a fresh block starts at one").toBe(1);

      // An absent `reason` on the PATCH must STILL mean "leave it alone", including for a block
      // whose note is already null: the create's collapse of absent and null must not have leaked
      // into the edit, where the two are genuinely different requests.
      const colourOnly = await patch(block.id, { version: block.version, colorSlot: 3 });
      expect(colourOnly.statusCode, colourOnly.body).toBe(200);
      expect(colourOnly.json()).toMatchObject({ reason: null, colorSlot: 3, version: 2 });

      const labelled = await patch(block.id, { version: 2, reason: "  Added later  " });
      expect(labelled.statusCode, labelled.body).toBe(200);
      expect(labelled.json()).toMatchObject({ reason: "Added later", version: 3 });
      expect((await stored(block.id))!.reason).toBe("Added later");

      const cleared = await patch(block.id, { version: 3, reason: null });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json()).toMatchObject({ reason: null, version: 4 });
      expect(await storedReasonIsNull(block.id)).toBe(true);

      // Back to unlabelled, and clearing again is the no-op it is for a block that arrived
      // labelled: "unchanged" is measured against what is stored, never against how it got there.
      const again = await patch(block.id, { version: 4, reason: null });
      expect(again.statusCode, again.body).toBe(200);
      expect((again.json() as BlockRow).version, "no fifth step").toBe(4);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("who may edit and remove a block", () => {
    /**
     * THE ROLE MATRIX, THROUGH HTTP RATHER THAN THROUGH THE PERMISSION CATALOG.
     *
     * The three shipped presets are read from the domain package rather than restated, so a preset
     * edited without thinking about these routes fails here rather than in a salon. Each is invited
     * as a real member through the real invitation flow, so what is tested is a session's effective
     * access and not a helper's opinion of it.
     *
     * `calendar.blocks_edit` is the gate - the twin 0055 granted alongside `calendar.blocks_create`
     * to every role that could already block time out. The Receptionist is the load-bearing one:
     * blocking out time is front-desk work, and so is fixing the block you just got wrong.
     */
    it("lets Owner, Manager and Receptionist edit and delete, and refuses a Groomer", async () => {
      const presets = ["manager", "receptionist", "groomer"] as const;
      const edits: Record<string, number> = {};
      const deletes: Record<string, number> = {};
      for (const [index, preset] of presets.entries()) {
        const cookie = await sessionWith(permissionPresets[preset]!);
        // Its own hour, so a refusal is never one role colliding with another's block.
        const hour = String(9 + index).padStart(2, "0");
        const block = await created({
          localStart: `${WINTER}T${hour}:00`, localEnd: `${WINTER}T${hour}:30`,
          reason: `${preset} block`, employeeId: secondEmployeeId
        });
        const edited = await patch(block.id, { version: block.version, reason: `${preset} edited` }, cookie);
        edits[preset] = edited.statusCode;
        const removed = await remove(
          block.id, edited.statusCode === 200 ? (edited.json() as BlockRow).version : block.version,
          cookie
        );
        deletes[preset] = removed.statusCode;
      }
      expect(edits.manager, "Manager edit").toBe(200);
      expect(edits.receptionist, "Receptionist edit").toBe(200);
      expect(edits.groomer, "Groomer edit").toBe(403);
      expect(deletes.manager, "Manager delete").toBe(204);
      expect(deletes.receptionist, "Receptionist delete").toBe(204);
      expect(deletes.groomer, "Groomer delete").toBe(403);

      // And the owner, who holds no role at all - ownership is a flag on the membership, not a
      // permission set, so `can()` short-circuits before any key is consulted.
      const ownerBlock = await created({
        localStart: `${WINTER}T16:00`, localEnd: `${WINTER}T16:30`, reason: "Owner block",
        employeeId: secondEmployeeId
      });
      expect((await patch(ownerBlock.id, { version: 1, reason: "Owner edited" })).statusCode).toBe(200);
      expect((await remove(ownerBlock.id, 2)).statusCode).toBe(204);
    });

    /**
     * THE GATE IS `calendar.blocks_edit` AND NOTHING ELSE. Without these two cases every assertion
     * above would pass just as well against the old `appointments.edit` gate, since all three
     * presets that can edit a block also hold that key.
     */
    it("consults calendar.blocks_edit, not appointments.edit and not blocks_create", async () => {
      const block = await created({
        localStart: `${WINTER}T17:00`, localEnd: `${WINTER}T17:30`, reason: "Gate",
        employeeId: secondEmployeeId
      });
      // Neither the appointment key nor the block CREATE key is enough. A role holding create and
      // not edit is not among the presets - 0055 grants the pair together - but an owner can author
      // one, and it must be refused or the two keys are one key.
      const wrongKeys = await sessionWith([
        "calendar.view", "appointments.view", "appointments.edit", "calendar.blocks_create"
      ]);
      const refused = await patch(block.id, { version: block.version, reason: "No" }, wrongKeys);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toContain("calendar.blocks_edit");
      const refusedDelete = await remove(block.id, block.version, wrongKeys);
      expect(refusedDelete.statusCode, refusedDelete.body).toBe(403);
      expect(refusedDelete.json().error).toContain("calendar.blocks_edit");

      // And the edit key IS enough: it is a permission in its own right, not a second switch that
      // has to be held alongside the one that creates blocks. `appointments.edit_all_staff` rides
      // along because the block is on another groomer's calendar and this member has no employee
      // record; the scope rule has its own suite, and this case is about which key is consulted.
      const editOnly = await sessionWith([
        "calendar.view", "calendar.blocks_edit", "appointments.edit_all_staff"
      ]);
      const allowed = await patch(block.id, { version: block.version, reason: "Yes" }, editOnly);
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect((await remove(block.id, (allowed.json() as BlockRow).version, editOnly)).statusCode)
        .toBe(204);
    });

    it("keeps READING a block's history separate from WRITING the block", async () => {
      // A groomer who may not edit a block still has to be able to read why the region on their
      // column exists. The activity read stays on `appointments.view`, the permission the calendar
      // read uses.
      const block = await created({
        localStart: `${WINTER}T15:00`, localEnd: `${WINTER}T15:30`, reason: "Readable",
        employeeId: secondEmployeeId
      });
      const groomer = await sessionWith(permissionPresets.groomer!);
      const seen = await activity(block.id, groomer);
      expect(seen.statusCode, seen.body).toBe(200);
      expect((seen.json().items as ActivityItem[]).length).toBeGreaterThan(0);
      // And a session with neither key is refused outright.
      const outsider = await sessionWith(["calendar.view"]);
      expect((await activity(block.id, outsider)).statusCode).toBe(403);
    });

    /**
     * CROSS-TENANT NON-DISCLOSURE, THE WAY THE REST OF THE CODEBASE DOES IT: a 404, not a 403.
     * A 403 would confirm the id names something real somewhere else, which is precisely what must
     * not be learnable. The rival's block is a REAL id in a REAL other business, so this cannot
     * pass by accident the way a random uuid could.
     */
    it("answers for another salon's block exactly as it answers for one that never existed", async () => {
      const invented = crypto.randomUUID();
      for (const [label, id] of [["rival", rivalBlockId], ["invented", invented]] as const) {
        const edit = await patch(id, { version: 1, reason: "Reaching over" });
        expect(edit.statusCode, `${label} edit: ${edit.body}`).toBe(404);
        expect(edit.json(), label).toEqual({ error: "Blocked time not found" });

        const removed = await remove(id, 1);
        expect(removed.statusCode, `${label} delete: ${removed.body}`).toBe(404);
        expect(removed.json(), label).toEqual({ error: "Blocked time not found" });

        const history = await activity(id);
        expect(history.statusCode, `${label} activity: ${history.body}`).toBe(404);
        expect(history.json(), label).toEqual({ error: "Blocked time not found" });
      }
      // The rival's block is untouched and still theirs.
      const survivor = await stored(rivalBlockId);
      expect(survivor, "the rival's block survives").toBeDefined();
      expect(survivor!.reason).toBe("Rival lunch");
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("what a block's history says", () => {
    /**
     * A BLOCK WRITTEN BEFORE THE AUDIT WIRING GETS A `Created` ENTRY DERIVED FROM ITS COLUMNS, AND
     * NOTHING SYNTHETIC IS WRITTEN TO `audit_events`.
     *
     * Backfilling one event per historical row would put entries in the audit log describing
     * something the log did not observe, and every later reader of that table would have to know
     * which entries were manufactured. So the entry is derived at read time from `created_by` and
     * `created_at`, flagged `derived: true`, and carries no field values - the columns attest WHO
     * and WHEN and nothing else, and the row may have been edited since.
     *
     * The block here is inserted directly, which is exactly the shape of every block written before
     * the create route started calling `record()`.
     */
    it("reconstructs a Created entry for a block that predates the audit trail, and marks it", async () => {
      const start = `${WINTER}T18:00:00Z`;
      const end = `${WINTER}T18:30:00Z`;
      const [legacy] = await db<{ id: string }[]>`
        insert into blocked_times(business_id,employee_id,location_id,start_at,end_at,
          scheduling_timezone,scheduled_local_start,scheduled_local_end,reason,
          created_by,created_at,updated_by,updated_at)
        values (${businessId},${employeeId},${locationId},
          ${start}::timestamptz,${end}::timestamptz,'America/Los_Angeles',
          ${start}::timestamptz at time zone 'America/Los_Angeles',
          ${end}::timestamptz at time zone 'America/Los_Angeles',
          'Legacy lunch',${ownerUserId},'2028-01-05T18:00:00Z'::timestamptz,
          ${ownerUserId},'2028-01-05T18:00:00Z'::timestamptz)
        returning id
      `;
      // NOTHING WAS WRITTEN TO THE LOG FOR IT, which is the precondition the derivation is gated on.
      expect(await auditRows(legacy!.id)).toEqual([]);

      const response = await activity(legacy!.id);
      expect(response.statusCode, response.body).toBe(200);
      const items = response.json().items as ActivityItem[];
      expect(items).toHaveLength(1);
      const derived = items[0]!;
      expect(derived.derived, "reconstructed entries say so").toBe(true);
      expect(derived.action).toBe("blocked_time.create");
      expect(derived.id).not.toMatch(/^[0-9a-f]{8}-/u);
      expect(new Date(derived.createdAt).toISOString()).toBe("2028-01-05T18:00:00.000Z");
      expect(derived.actorName, "the author is named through the same join").toBeTruthy();
      // It carries no field values. The row may have been edited since, and reporting today's
      // hours inside an entry labelled Created would state as history something nobody recorded.
      expect(derived.toStartAt).toBeNull();
      expect(derived.toEndAt).toBeNull();
      expect(derived.toReason).toBeNull();
      expect(derived.toVersion).toBeNull();

      // AND A REAL EDIT LANDS BESIDE IT, DISTINGUISHABLE. Newest first, so the reconstructed entry
      // is last and the real one leads.
      const edited = (await patch(legacy!.id, { version: 1, reason: "Legacy lunch, corrected" }))
        .json() as BlockRow;
      const mixed = (await activity(legacy!.id)).json().items as ActivityItem[];
      expect(mixed.map((item) => [item.action, item.derived])).toEqual([
        ["blocked_time.update", false],
        ["blocked_time.create", true]
      ]);
      const update = mixed[0]!;
      expect(update.fromReason).toBe("Legacy lunch");
      expect(update.toReason).toBe("Legacy lunch, corrected");
      expect(update.fromVersion).toBe(1);
      expect(update.toVersion).toBe(edited.version);
      // Still exactly one row in the log: the derivation invented nothing in the database.
      expect((await auditRows(legacy!.id)).map((row) => row.action)).toEqual(["blocked_time.update"]);
    });

    /**
     * A BLOCK CREATED FROM NOW ON HAS A REAL CREATE EVENT, AND NEVER BOTH.
     */
    it("uses the real create event for a block written through the route", async () => {
      const block = await created({
        localStart: `${SUMMER}T16:00`, localEnd: `${SUMMER}T16:30`, reason: "Recorded",
        colorSlot: 1, employeeId: secondEmployeeId
      });
      const items = (await activity(block.id)).json().items as ActivityItem[];
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        action: "blocked_time.create",
        derived: false,
        fromStartAt: null,
        toStartAt: block.startAt,
        toEndAt: block.endAt,
        toEmployeeId: secondEmployeeId,
        toReason: "Recorded",
        toColorSlot: 1,
        toVersion: 1
      });
      // It is a real row, under the namespaced action and resource type.
      const rows = await auditRows(block.id);
      expect(rows.map((row) => row.action)).toEqual(["blocked_time.create"]);
      // AND NO OUTBOX OR ANALYTICS EVENT. `record()` writes those only when given an `eventType`,
      // and a block has no downstream consumer; naming one would enrol blocked times in a pipeline
      // nobody asked for.
      const [outbox] = await db<{ count: number }[]>`
        select count(*)::int as count from outbox_events where resource_id=${block.id}
      `;
      expect(outbox!.count).toBe(0);
      const [analytics] = await db<{ count: number }[]>`
        select count(*)::int as count from product_analytics_events where resource_id=${block.id}
      `;
      expect(analytics!.count).toBe(0);
    });

    /**
     * DELETION STAYS AUDITABLE AFTER THE LIVE ROW IS GONE.
     *
     * `audit_events.resource_id` carries no foreign key, so the trail outlives the row - and the
     * `before` payload of the delete is the WHOLE prior row, so what was removed is recoverable
     * from the log rather than merely noted as having happened.
     */
    it("keeps the whole removed block in the trail, and answers for it afterwards", async () => {
      const block = await created({
        localStart: `${SUMMER}T17:00`, localEnd: `${SUMMER}T17:30`, reason: "Doomed but recorded",
        colorSlot: 8, employeeId: secondEmployeeId
      });
      expect((await remove(block.id, block.version)).statusCode).toBe(204);
      expect(await stored(block.id), "the row is really gone").toBeUndefined();

      // GONE FROM THE READ PATH, NOT MERELY FROM THE TABLE. The assertion above is a direct
      // database look-up, which cannot answer the question a client actually asks: a deleted block
      // must stop being retrievable through the ordinary block APIs even though its history below
      // survives. So the calendar read is checked, and both mutations are checked too - a client
      // still holding the id must be told the block is not there rather than acting on it.
      expect((await read(SUMMER)).some((row) => row.id === block.id),
        "the calendar read still offers a deleted block").toBe(false);
      expect((await patch(block.id, { version: 1, reason: "After the funeral" })).statusCode,
        "a deleted block still accepts an edit").toBe(404);
      expect((await remove(block.id, 1)).statusCode,
        "a deleted block still accepts a delete").toBe(404);

      const rows = await auditRows(block.id);
      expect(rows.map((row) => row.action)).toEqual(["blocked_time.create", "blocked_time.delete"]);
      // THE FULL PRIOR ROW, so the block is reconstructable from the log alone: both bounds as
      // instants AND as the salon's wall clock, the zone relating them, the groomer, the location,
      // the reason, the colour and the version it died at.
      expect(rows[1]!.beforeData).toMatchObject({
        employeeId: secondEmployeeId,
        locationId,
        startAt: block.startAt,
        endAt: block.endAt,
        schedulingTimezone: "America/Los_Angeles",
        scheduledLocalStart: `${SUMMER}T17:00`,
        scheduledLocalEnd: `${SUMMER}T17:30`,
        reason: "Doomed but recorded",
        colorSlot: 8,
        version: 1
      });
      expect(rows[1]!.afterData, "a delete has no after").toBeNull();

      // And the history endpoint still answers, because a trail that vanished with the thing it is
      // a trail of would make the delete unauditable through the API.
      const response = await activity(block.id);
      expect(response.statusCode, response.body).toBe(200);
      const items = response.json().items as ActivityItem[];
      expect(items.map((item) => item.action))
        .toEqual(["blocked_time.delete", "blocked_time.create"]);
      expect(items[0]).toMatchObject({
        derived: false,
        fromStartAt: block.startAt,
        fromEndAt: block.endAt,
        fromEmployeeId: secondEmployeeId,
        fromReason: "Doomed but recorded",
        fromColorSlot: 8,
        fromVersion: 1,
        toStartAt: null,
        toVersion: null
      });
      // NO DERIVED ENTRY IS INVENTED FOR A ROW THAT NO LONGER EXISTS: there is a real create event
      // here, and there are no columns left to derive one from either.
      expect(items.some((item) => item.derived)).toBe(false);
    });

    /**
     * A MOVE READS AS A MOVE. The whitelist is `startAt`, `endAt`, `employeeId`, `reason`,
     * `colorSlot` and `version` as `from`/`to` pairs, and nothing else out of the payload reaches
     * the wire - the audit record is written by this server and is wider than its contract.
     */
    it("states what a move changed, and publishes no more of the payload than that", async () => {
      const block = await created({
        localStart: `${SUMMER}T09:00`, localEnd: `${SUMMER}T09:30`, reason: "Moving",
        employeeId: secondEmployeeId
      });
      const moved = (await patch(block.id, {
        version: block.version, employeeId,
        localStart: `${SUMMER}T10:00`, localEnd: `${SUMMER}T10:30`,
        expectedLocationVersion: await locationVersion(locationId)
      })).json() as BlockRow;

      const items = (await activity(block.id)).json().items as ActivityItem[];
      const update = items.find((item) => item.action === "blocked_time.update")!;
      expect(update.fromStartAt).toBe(block.startAt);
      expect(update.toStartAt).toBe(moved.startAt);
      expect(update.fromEndAt).toBe(block.endAt);
      expect(update.toEndAt).toBe(moved.endAt);
      expect(update.fromEmployeeId).toBe(secondEmployeeId);
      expect(update.toEmployeeId).toBe(employeeId);
      expect(update.fromVersion).toBe(1);
      expect(update.toVersion).toBe(2);

      // THE WHITELIST IS CLOSED. The stored payload carries the location and the salon's wall
      // clock; neither reaches the client, because the raw record shape is not an API contract.
      expect(Object.keys(update).sort()).toEqual([
        "action", "actorName", "createdAt", "derived", "fromColorSlot", "fromEmployeeId",
        "fromEndAt", "fromReason", "fromStartAt", "fromVersion", "id", "reason", "toColorSlot",
        "toEmployeeId", "toEndAt", "toReason", "toStartAt", "toVersion"
      ]);
      // The actor is a name a person recognises, resolved through the same
      // users -> business_memberships -> employees join the appointment feed uses.
      expect(update.actorName).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("scheduling integrity", () => {
    /**
     * AN EDIT REACHES THE AUTHORITATIVE CONSTRAINT IMMEDIATELY, WITH NO SECOND CODE PATH.
     *
     * `refuseStaffAvailability` subtracts `blocked_times` at step 5 of the availability authority,
     * and the booking routes consult that and nothing else. These cases prove there is no cached
     * copy anywhere between the edit and the refusal: the same booking flips from refused to
     * accepted and back, decided only by where the block is.
     */
    it("frees the slot the moment the block is deleted", async () => {
      const block = await created({
        localStart: `${WINTER}T11:00`, localEnd: `${WINTER}T11:30`, reason: "In the way"
      });
      const refused = await book(`${WINTER}T11:00`);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: "TIME_BLOCKED", canOverride: false });

      expect((await remove(block.id, block.version)).statusCode).toBe(204);

      const accepted = await book(`${WINTER}T11:00`);
      expect(accepted.statusCode, accepted.body).toBe(201);
    });

    it("frees the slot the moment the block is moved off it", async () => {
      const block = await created({
        localStart: `${SUMMER}T11:00`, localEnd: `${SUMMER}T11:30`, reason: "Moving away",
        employeeId: secondEmployeeId
      });
      const refused = await book(`${SUMMER}T11:00`, secondEmployeeId);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: "TIME_BLOCKED", canOverride: false });

      const moved = await patch(block.id, {
        version: block.version, employeeId: secondEmployeeId,
        localStart: `${SUMMER}T15:00`, localEnd: `${SUMMER}T15:30`,
        expectedLocationVersion: await locationVersion(locationId)
      });
      expect(moved.statusCode, moved.body).toBe(200);

      const accepted = await book(`${SUMMER}T11:00`, secondEmployeeId);
      expect(accepted.statusCode, accepted.body).toBe(201);
    });

    /**
     * AND THE OTHER DIRECTION: a slot that booked cleanly is refused once a block is moved onto it.
     *
     * The first booking is cancelled before the block moves, so the second attempt is refused by
     * the BLOCK rather than by the appointment already sitting there - a conflict check runs before
     * the availability authority and would otherwise mask the answer this case is about.
     */
    it("refuses a slot that booked cleanly once a block is moved onto it", async () => {
      const accepted = await book(`${WINTER}T14:00`, secondEmployeeId);
      expect(accepted.statusCode, accepted.body).toBe(201);
      const appointmentId = accepted.json().id as string;
      const cancelled = await app.inject({
        method: "POST", url: `/api/appointments/${appointmentId}/transition`,
        headers: { cookie: ownerCookie }, payload: { status: "cancelled", reason: "Making room" }
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);

      const block = await created({
        localStart: `${WINTER}T08:00`, localEnd: `${WINTER}T08:30`, reason: "Moving in",
        employeeId: secondEmployeeId
      });
      const moved = await patch(block.id, {
        version: block.version, employeeId: secondEmployeeId,
        localStart: `${WINTER}T14:00`, localEnd: `${WINTER}T14:30`,
        expectedLocationVersion: await locationVersion(locationId)
      });
      expect(moved.statusCode, moved.body).toBe(200);

      const refused = await book(`${WINTER}T14:00`, secondEmployeeId);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: "TIME_BLOCKED", canOverride: false });
    });

    /**
     * A MOVED BLOCK IS STILL HARD. `availabilityOverrideMayBypass` is an allow-list of
     * `outside_staff_hours` and `outside_business_hours`; `fully_blocked` is not on it and no
     * mutation route introduces a way around it. The answer to needing the slot is to move or
     * delete the block, which is what these routes are for.
     */
    it("gives nobody a way past TIME_BLOCKED, before or after an edit", async () => {
      const block = await created({
        localStart: `${SUMMER}T13:00`, localEnd: `${SUMMER}T13:30`, reason: "Hard",
        employeeId: secondEmployeeId
      });
      const moved = await patch(block.id, {
        version: block.version, employeeId: secondEmployeeId,
        localStart: `${SUMMER}T16:00`, localEnd: `${SUMMER}T16:30`,
        expectedLocationVersion: await locationVersion(locationId)
      });
      expect(moved.statusCode, moved.body).toBe(200);

      const forced = await app.inject({
        method: "POST", url: "/api/appointments",
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: {
          locationId, customerId, petId, employeeId: secondEmployeeId, serviceIds: [serviceId],
          localStart: `${SUMMER}T16:00`,
          expectedLocationVersion: await locationVersion(locationId),
          availabilityOverride: true, overrideReason: "Squeeze it in"
        }
      });
      expect(forced.statusCode, forced.body).toBe(409);
      expect(forced.json()).toMatchObject({ code: "TIME_BLOCKED", canOverride: false });
    });
  });
});
