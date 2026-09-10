import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissionPresets } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { createRole } from "../support/roles.js";

/**
 * WHO MAY BLOCK TIME OUT, AND WHAT THE CREATE ROUTE ANSWERS WITH.
 *
 * Two things landed together and each is easy to get quietly wrong in the opposite direction, so
 * they are pinned side by side rather than left to the change that made them.
 *
 * 1. THE GATE MOVED, AND NOBODY LOST THE BUTTON. `POST /api/blocked-times` was gated on
 *    `appointments.edit` from the day it was written. It is gated on `calendar.blocks_create` now
 *    - the key the taxonomy reserved for exactly this route in 0045 and then left enforcing
 *    nothing. A gate that moves is a silent revocation waiting to happen: the Receptionist preset
 *    holds `appointments.edit` and held NEITHER block key, so without a preset change and a
 *    migration, every front desk in every workspace would have found the button refusing them with
 *    no release note. So the assertion that matters is PARITY - the same four answers before and
 *    after - and not "the new permission works".
 *
 * 2. THE RESPONSE STOPPED LEAKING A WALL CLOCK. The route ended `returning *`, which handed
 *    postgres.js the raw `scheduled_local_*` columns. Those are `timestamp without time zone`, so
 *    the driver parses them with `new Date(x)` in the API HOST's timezone and serialises an
 *    instant: on a UTC host serving a UTC-8 salon, creating a 12:00 block answered 20:00Z. That is
 *    migration 0051's defect - the one that printed a 10:00 groom as 17:00 - on the one field a
 *    calendar column has to place.
 *
 * EVERY TIME HERE IS AMERICA/LOS_ANGELES, following `blocked-time-visibility.test.ts`, and for its
 * reason: a UTC salon cannot fail the wall-clock case at all, because the host and the salon
 * agree. The February dates are PST (UTC-8) and the July one is PDT (UTC-7), so a fixed-offset
 * implementation passes one and fails the other.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "blocked-time-management-secret-32-characters",
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
const WINTER = "2028-02-15";
/** PDT, UTC-7, so the offset is not a constant. */
const SUMMER = "2028-07-18";

interface BlockRow {
  id: string;
  employeeId: string;
  employeeName: string;
  locationId: string;
  reason: string | null;
  colorSlot: number | null;
  startAt: string;
  endAt: string;
  schedulingTimezone: string;
  scheduledLocalStart: string;
  scheduledLocalEnd: string;
}

describeDatabase("blocking time out", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string;
  let locationId: string;
  let employeeId: string, employeeName: string;
  const suffix = crypto.randomUUID().slice(0, 8);
  let seq = 0;

  const locationVersion = async () => {
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } });
    return me.json().business.locationVersion as number;
  };

  /** A member session holding exactly `permissions` and nothing else. */
  async function sessionWith(permissions: readonly string[]): Promise<string> {
    seq += 1;
    const email = `block-role-${seq}-${suffix}@example.test`;
    const roleId = await createRole(app, ownerCookie, `Block role ${seq} ${suffix}`, permissions);
    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email, roleId }
    });
    expect(invitation.statusCode, invitation.body).toBe(201);
    const token = new URL(invitation.json().acceptancePath, "http://localhost")
      .searchParams.get("invite");
    const accepted = await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: "correct horse blocked management" }
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    return sessionCookie(accepted);
  }

  /** The create route, exactly as an operator's block reaches it. */
  const blockTime = async (input: {
    localStart: string; localEnd: string; reason?: string;
    colorSlot?: number | null; cookie?: string;
  }) => app.inject({
    method: "POST", url: "/api/blocked-times", headers: { cookie: input.cookie ?? ownerCookie },
    payload: {
      employeeId, locationId,
      localStart: input.localStart, localEnd: input.localEnd,
      reason: input.reason ?? "Lunch",
      expectedLocationVersion: await locationVersion(),
      ...(input.colorSlot === undefined ? {} : { colorSlot: input.colorSlot })
    }
  });

  const read = async (localDate: string) => {
    const response = await app.inject({
      method: "GET", url: `/api/blocked-times?localDate=${localDate}&days=1`,
      headers: { cookie: ownerCookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as BlockRow[];
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `block-management-${suffix}@example.test`,
      password: "correct horse blocked management", businessName: `Block Management ${suffix}`
    }});
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = sessionCookie(signup);
    ({ locationId } = signup.json());
    // Set before any location version is read, and set in SQL, which does not move that version.
    await db`update locations set timezone='America/Los_Angeles' where id=${locationId}`;

    employeeName = `Bea Blocker ${suffix}`;
    employeeId = (await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: employeeName, serviceIds: [] }
    })).json().id;
  }, 60_000);

  afterAll(async () => { await app.close(); await db.end(); });

  describe("who may block time out", () => {
    /**
     * THE PARITY CASE, AND THE ONLY ONE THAT WOULD HAVE CAUGHT THE REGRESSION THIS CHANGE RISKED.
     *
     * The three shipped presets are read from the domain package rather than restated, so a preset
     * edited without thinking about this route fails here rather than in a salon. Each is invited
     * as a real member through the real invitation flow, so what is being tested is a session's
     * effective access and not a helper's opinion of it.
     *
     * The Receptionist is the load-bearing one: it can block time out today, and every part of
     * this change exists to keep that true.
     */
    it("lets exactly the roles that could block time out before go on doing it", async () => {
      const presets = ["manager", "receptionist", "groomer"] as const;
      const answers: Record<string, number> = {};
      for (const [index, preset] of presets.entries()) {
        const cookie = await sessionWith(permissionPresets[preset]!);
        // Its own hour, so a refusal is never one role colliding with another's block.
        const hour = String(5 + index).padStart(2, "0");
        const response = await blockTime({
          localStart: `${WINTER}T${hour}:00`, localEnd: `${WINTER}T${hour}:30`,
          reason: `${preset} block`, cookie
        });
        answers[preset] = response.statusCode;
      }
      // A Manager could, and can. A Receptionist could, and CAN - the whole point of the preset
      // change and of the migration that backfills roles which already exist.
      expect(answers.manager, "Manager").toBe(201);
      expect(answers.receptionist, "Receptionist").toBe(201);
      // A Groomer could not, and still cannot. This change is a preservation, not a widening.
      expect(answers.groomer, "Groomer").toBe(403);

      // And the owner, who holds no role at all - ownership is a flag on the membership, not a
      // permission set, so `can()` short-circuits before any key is consulted.
      expect((await blockTime({
        localStart: `${WINTER}T08:00`, localEnd: `${WINTER}T08:30`, reason: "Owner block"
      })).statusCode).toBe(201);
    });

    /**
     * THE GATE REALLY MOVED. Without this, every assertion above would pass just as well against
     * the old `appointments.edit` gate, since all three presets that can create a block also hold
     * that key. These two cases isolate the key that is actually being consulted.
     */
    it("consults calendar.blocks_create, not appointments.edit", async () => {
      // The old key alone is no longer enough. A role in this shape does not exist among the
      // presets any more - the migration and the preset change together see to that - but an owner
      // can still author one, and it must be refused, or the dedicated switch gates nothing.
      const oldKeyOnly = await sessionWith([
        "calendar.view", "appointments.view", "appointments.create", "appointments.edit"
      ]);
      const refused = await blockTime({
        localStart: `${WINTER}T09:00`, localEnd: `${WINTER}T09:30`, cookie: oldKeyOnly
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toContain("calendar.blocks_create");

      // And the new key alone IS enough: it is a permission in its own right, not a second switch
      // that has to be held alongside the one it replaced.
      const newKeyOnly = await sessionWith(["calendar.view", "calendar.blocks_create"]);
      expect((await blockTime({
        localStart: `${WINTER}T10:00`, localEnd: `${WINTER}T10:30`, cookie: newKeyOnly
      })).statusCode).toBe(201);
    });

    it("keeps SEEING a block separate from WRITING one", async () => {
      // A groomer who may not block time out still has to be able to see the blocks on their own
      // column, or the calendar refuses a drag for a region it drew nothing for - which is the
      // defect the read route was added to fix. The read stays on `appointments.view`.
      const groomer = await sessionWith(permissionPresets.groomer!);
      const seen = await app.inject({
        method: "GET", url: `/api/blocked-times?localDate=${WINTER}&days=1`,
        headers: { cookie: groomer }
      });
      expect(seen.statusCode, seen.body).toBe(200);
      expect((seen.json() as BlockRow[]).length).toBeGreaterThan(0);
    });
  });

  describe("what the create route answers with", () => {
    /**
     * THE CONTRACT, IN ONE ASSERTION, BECAUSE A CLIENT CODES AGAINST EXACTLY THIS.
     *
     * The created block is painted onto the same grid as the blocks a refetch returns, so the two
     * answers must be one answer. This compares the WHOLE object rather than a chosen field:
     * a projection that drifts by one key between the two routes is a client rendering a block it
     * just created differently from the same block a second later.
     */
    it("returns exactly what the read route returns for the same block", async () => {
      const created = await blockTime({
        localStart: `${WINTER}T12:00`, localEnd: `${WINTER}T12:30`,
        reason: "Lunch", colorSlot: 4
      });
      expect(created.statusCode, created.body).toBe(201);
      const written = created.json() as BlockRow;

      const fetched = (await read(WINTER)).find((row) => row.id === written.id);
      expect(fetched, "the created block must be reachable through the read route").toBeDefined();
      expect(written).toEqual(fetched);

      // And it is the full shape, stated once so a field silently dropped from BOTH routes cannot
      // pass the comparison above.
      expect(written).toMatchObject({
        employeeId, employeeName, locationId,
        reason: "Lunch", colorSlot: 4,
        schedulingTimezone: "America/Los_Angeles",
        scheduledLocalStart: `${WINTER}T12:00`,
        scheduledLocalEnd: `${WINTER}T12:30`
      });
      expect(written.id).toEqual(expect.any(String));
    });

    /**
     * THE LEAK ITSELF. `returning *` sent the naive columns through the driver, and the driver
     * reinterpreted them in the host's timezone.
     */
    it("states the salon's wall clock as text, on both sides of a daylight-saving change", async () => {
      const winter = (await blockTime({
        localStart: `${WINTER}T13:00`, localEnd: `${WINTER}T13:30`, reason: "Winter"
      })).json() as BlockRow;

      expect(typeof winter.scheduledLocalStart).toBe("string");
      expect(winter.scheduledLocalStart).toMatch(WALL_CLOCK);
      expect(winter.scheduledLocalEnd).toMatch(WALL_CLOCK);
      // No seconds, no zone - a wall clock is not an instant and must not look like one.
      expect(winter.scheduledLocalStart).not.toContain("Z");
      expect(winter.scheduledLocalStart).toBe(`${WINTER}T13:00`);
      // PST is UTC-8, so 13:00 at the salon is 21:00Z. 21:00 is what the defect returned in the
      // wall-clock field, which is why this pair is asserted together.
      expect(winter.startAt).toBe(`${WINTER}T21:00:00.000Z`);
      expect(winter.scheduledLocalStart).not.toBe(winter.startAt.slice(0, 16));

      // The same 13:00 in July is PDT, an hour off PST. A fixed-offset implementation passes the
      // case above and fails this one.
      const summer = (await blockTime({
        localStart: `${SUMMER}T13:00`, localEnd: `${SUMMER}T13:30`, reason: "Summer"
      })).json() as BlockRow;
      expect(summer.scheduledLocalStart).toBe(`${SUMMER}T13:00`);
      expect(summer.endAt).toBe(`${SUMMER}T20:30:00.000Z`);
      expect(summer.startAt).toBe(`${SUMMER}T20:00:00.000Z`);

      // AND THE STORED COLUMNS AGREE WITH WHAT WAS RETURNED. The local pair is written from the
      // resolved instant in SQL rather than bound from the operator's submitted string, so the row
      // and the response state one wall clock. Read as TEXT here for the same reason the route
      // returns text: comparing a `timestamp without time zone` as a Date is the original bug.
      const [stored] = await db<{ localStart: string; localEnd: string }[]>`
        select to_char(scheduled_local_start,'YYYY-MM-DD"T"HH24:MI') as local_start,
          to_char(scheduled_local_end,'YYYY-MM-DD"T"HH24:MI') as local_end
        from blocked_times where id=${summer.id}
      `;
      expect(stored!.localStart).toBe(summer.scheduledLocalStart);
      expect(stored!.localEnd).toBe(summer.scheduledLocalEnd);
    });

    it("reports a block nobody chose a colour for as null, rather than dealing it one", async () => {
      // Null is a real answer: it means the operator did not pick, and the calendar draws the
      // default band. Unlike a groomer's slot there is no hash fallback, deliberately - a
      // groomer's colour identifies a person across every screen, a block's is a label on one
      // region of one day.
      const created = (await blockTime({
        localStart: `${WINTER}T14:00`, localEnd: `${WINTER}T14:30`, reason: "No colour"
      })).json() as BlockRow;
      expect(created.colorSlot).toBeNull();
      // Explicit null is the same answer as omitting it, so a client clearing a colour and a
      // client that never had one are not two cases to render.
      const cleared = (await blockTime({
        localStart: `${WINTER}T15:00`, localEnd: `${WINTER}T15:30`,
        reason: "Cleared colour", colorSlot: null
      })).json() as BlockRow;
      expect(cleared.colorSlot).toBeNull();
    });

    /**
     * THE PALETTE IS ENFORCED IN THE DOMAIN, NOT BY THE DATABASE CHECK.
     *
     * The column's `between 0 and 15` is 0040's durable outer bound, deliberately wider than the
     * ten colours that exist, so widening the palette stays a constant and a stylesheet. That
     * makes THIS the boundary that refuses a slot no token exists for - and it must refuse with a
     * 400 about the request, not let the write through to a constraint that would answer 409 about
     * a data integrity rule an operator cannot act on.
     */
    it("refuses a slot the palette has no colour for", async () => {
      // 9 is the last real colour; 10 is the first that is not.
      expect((await blockTime({
        localStart: `${WINTER}T16:00`, localEnd: `${WINTER}T16:30`, colorSlot: 9
      })).statusCode).toBe(201);
      for (const slot of [10, 16, -1, 1.5]) {
        const refused = await blockTime({
          localStart: `${WINTER}T17:00`, localEnd: `${WINTER}T17:30`, colorSlot: slot
        });
        expect(refused.statusCode, `slot ${slot}: ${refused.body}`).toBe(400);
      }
    });
  });
});
