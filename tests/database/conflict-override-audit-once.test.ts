import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * "SAVED OVER ANOTHER APPOINTMENT" IS WRITTEN ONCE PER OVERLAP THE CALLER ACTUALLY MADE.
 *
 * `appointment.conflict_override` is the compliance trail for laying one appointment over another.
 * Every mutation that CREATES or CHANGES an overlap writes exactly one such row: the booking that
 * lands over another, a move to new minutes that still overlaps, a duration edit that grows into
 * a neighbour. A request that changes nothing about where the visit sits - a move saved onto the
 * exact minutes and groomers it already holds, or a service edit whose minutes sum to the same
 * window - decides nothing new and must not write a second, identical "Saved over another
 * appointment" row beside the first. The history used to show one for every such save.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "conflict-override-audit-once-secret-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const sessionCookie = (response: { headers: Record<string, unknown> }) => {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
};

describeDatabase("conflict override audit, one row per overlap made", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string, businessId: string, locationId: string;
  let customerId: string, petId: string, serviceId: string, employeeId: string;
  const suffix = crypto.randomUUID().slice(0, 8);
  const day = "2035-04-10";

  const book = async (localStart: string) => {
    const created = await app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { locationId, customerId, petId, employeeId, serviceIds: [serviceId], localStart, expectedLocationVersion: 1 }
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().id as string;
  };
  const version = async (id: string) =>
    (await db<{ version: number }[]>`select version from appointments where id=${id}`)[0]!.version;
  const move = async (id: string, localStart: string) => {
    const moved = await app.inject({
      method: "PATCH", url: `/api/appointments/${id}/schedule`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { employeeId, localStart, version: await version(id), expectedLocationVersion: 1 }
    });
    expect(moved.statusCode, moved.body).toBe(200);
    return moved.json();
  };
  const overrides = async (id: string) => (await db<{ count: number }[]>`
    select count(*)::int count from audit_events
    where business_id=${businessId} and resource_id=${id} and action='appointment.conflict_override'
  `)[0]!.count;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `override-once-${suffix}@example.test`, password: "correct horse override once",
      businessName: `Override Once ${suffix}`
    }});
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = sessionCookie(signup);
    ({ businessId, locationId } = signup.json());
    const post = async (url: string, payload: Record<string, unknown>) =>
      (await app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload })).json().id as string;
    serviceId = await post("/api/services", { name: `Once Groom ${suffix}`, baseDurationMinutes: 60, basePriceMinor: 6000 });
    employeeId = await post("/api/employees", { displayName: `Once Groomer ${suffix}`, serviceIds: [serviceId] });
    customerId = await post("/api/customers", { firstName: "Once", lastName: "Client" });
    petId = await post("/api/pets", { customerId, name: "Once Pet", species: "dog" });
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it("records the booking over another once, and a move to new overlapping minutes once more", async () => {
    await book(`${day}T10:00`);
    const over = await book(`${day}T10:30`);
    expect(await overrides(over)).toBe(1);

    const moved = await move(over, `${day}T10:45`);
    expect(moved.scheduling.overrideApplied).toBe(true);
    expect(await overrides(over)).toBe(2);
  });

  it("changes nothing at all when a move is saved onto the minutes and groomer it already holds", async () => {
    await book(`${day}T13:00`);
    const over = await book(`${day}T13:30`);
    // A rabies notice waiting on the visit: a real move stands it down, a no-op must not.
    await db`
      insert into notification_intents
        (business_id,appointment_id,customer_id,notification_type,scheduled_occurrence,channel,destination,status)
      values (${businessId},${over},${customerId},'rabies_expiration_customer',now(),'email',${`rabies-${suffix}@example.test`},'pending')
    `;
    const snapshot = async () => {
      const [row] = await db<{ version: number; updatedAt: Date; conflictOverridden: boolean }[]>`
        select version,updated_at,conflict_overridden from appointments where id=${over}
      `;
      const actions = (await db<{ action: string }[]>`
        select action from audit_events where business_id=${businessId} and resource_id=${over} order by created_at,id
      `).map((event) => event.action).sort();
      const [intent] = await db<{ status: string }[]>`
        select status from notification_intents where appointment_id=${over} and notification_type='rabies_expiration_customer'
      `;
      return { ...row!, actions, intent: intent!.status };
    };
    const before = await snapshot();
    // Sorted: rows written in one transaction share its timestamp, so their order is not data.
    expect(before.actions).toEqual(["appointment.conflict_override", "appointment.create"]);

    // The Move dialog saved untouched, twice, and the second time replayed under its own key.
    const requestKey = crypto.randomUUID();
    const send = () => app.inject({
      method: "PATCH", url: `/api/appointments/${over}/schedule`,
      headers: { cookie: ownerCookie, "idempotency-key": requestKey },
      payload: { employeeId, localStart: `${day}T13:30`, version: before.version, expectedLocationVersion: 1 }
    });
    const first = await send();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      id: over, version: before.version, employeeId, scheduledLocalStart: `${day}T13:30`,
      conflictOverridden: true
    });
    const replay = await send();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const again = await move(over, `${day}T13:30`);
    expect(again.version).toBe(before.version);
    // No row, no version, no history entry, no notice stood down.
    expect(await snapshot()).toEqual(before);

    // A REAL move still writes exactly one move row, one override row for the overlap it makes,
    // moves the version and stands the notice down.
    const moved = await move(over, `${day}T13:45`);
    expect(moved.version).toBe(before.version + 1);
    const after = await snapshot();
    expect(after.actions).toEqual([...before.actions, "appointment.conflict_override", "appointment.move"].sort());
    expect(after.intent).toBe("cancelled");
  });

  it("writes no row for a service save whose minutes sum to the same window, and one when it grows", async () => {
    await book(`${day}T15:00`);
    const over = await book(`${day}T15:30`);
    expect(await overrides(over)).toBe(1);
    const [line] = await db<{ id: string }[]>`
      select id from appointment_services where appointment_id=${over}
    `;
    const same = await app.inject({
      method: "PUT", url: `/api/appointments/${over}/services`, headers: { cookie: ownerCookie },
      payload: { lines: [{ id: line!.id, serviceId }], version: await version(over) }
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(await overrides(over)).toBe(1);

    const grown = await app.inject({
      method: "PATCH", url: `/api/appointments/${over}/services/${line!.id}`, headers: { cookie: ownerCookie },
      payload: { durationMinutes: 75, version: await version(over) }
    });
    expect(grown.statusCode, grown.body).toBe(200);
    expect(await overrides(over)).toBe(2);
  });
});
