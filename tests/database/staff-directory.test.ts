import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "staff-directory-secret-at-least-thirty-two-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};
function cookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
}

/**
 * Guards the destructive-write regression in `PUT /api/employees/:id`.
 *
 * The route reused the CREATE schema, which defaults `serviceIds` to `[]` and reads an absent
 * `membershipId` as null. The web editor sends `{displayName}` alone, so renaming a groomer
 * cleared `employees.membership_id` and deleted every `employee_services` row they had.
 * `membership_id` is the join behind report-card author, agreement signer, rabies verifier,
 * photo uploader, note author, actor attribution and the mobile app's "which groomer am I", so a
 * rename detached a person from their own work history without saying so.
 */
describeDatabase("staff editing is a merge, not a replace", () => {
  let db: Database; let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string; let businessId: string;
  let membershipId: string; let employeeId: string;
  let bathId: string; let nailsId: string;
  const suffix = crypto.randomUUID();

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `staff-owner-${suffix}@example.test`,
        password: "correct horse staff battery",
        businessName: "Staff Merge Salon"
      }
    });
    expect(signup.statusCode).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId } = signup.json());
    membershipId = (await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } }))
      .json().membershipId;
    const service = async (name: string): Promise<string> => (await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name, baseDurationMinutes: 30, basePriceMinor: 3000 }
    })).json().id;
    bathId = await service("Merge Bath");
    nailsId = await service("Merge Nails");
    const created = await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: "Original Name", membershipId, serviceIds: [bathId, nailsId] }
    });
    expect(created.statusCode).toBe(201);
    employeeId = created.json().id;
  });
  afterAll(async () => { await app.close(); await db.end(); });

  async function stored(): Promise<{ displayName: string; membershipId: string | null; serviceIds: string[] }> {
    const [row] = await db<{ displayName: string; membershipId: string | null; serviceIds: string[] }[]>`
      select e.display_name, e.membership_id,
        coalesce(array_agg(es.service_id order by es.service_id)
          filter (where es.service_id is not null),'{}') as service_ids
      from employees e left join employee_services es on es.employee_id=e.id
      where e.business_id=${businessId} and e.id=${employeeId}
      group by e.id
    `;
    if (!row) throw new Error("Employee row missing");
    return row;
  }

  it("preserves the account link and every service row across a name-only edit", async () => {
    const before = await stored();
    expect(before.membershipId).toBe(membershipId);
    expect([...before.serviceIds].sort()).toEqual([bathId, nailsId].sort());

    const renamed = await app.inject({
      method: "PUT", url: `/api/employees/${employeeId}`, headers: { cookie: ownerCookie },
      payload: { displayName: "Renamed Groomer" }
    });
    expect(renamed.statusCode).toBe(200);

    const after = await stored();
    expect(after.displayName).toBe("Renamed Groomer");
    expect(after.membershipId).toBe(membershipId);
    expect([...after.serviceIds].sort()).toEqual([bathId, nailsId].sort());
  });

  it("still lets an operator unlink an account on purpose", async () => {
    const cleared = await app.inject({
      method: "PUT", url: `/api/employees/${employeeId}`, headers: { cookie: ownerCookie },
      payload: { membershipId: null }
    });
    expect(cleared.statusCode).toBe(200);
    expect((await stored()).membershipId).toBeNull();
    // An explicit unlink must not have taken the service rows with it.
    expect((await stored()).serviceIds).toHaveLength(2);

    const relinked = await app.inject({
      method: "PUT", url: `/api/employees/${employeeId}`, headers: { cookie: ownerCookie },
      payload: { membershipId }
    });
    expect(relinked.statusCode).toBe(200);
    expect((await stored()).membershipId).toBe(membershipId);
  });

  it("still lets an operator clear or narrow the service restriction on purpose", async () => {
    const narrowed = await app.inject({
      method: "PUT", url: `/api/employees/${employeeId}`, headers: { cookie: ownerCookie },
      payload: { serviceIds: [bathId] }
    });
    expect(narrowed.statusCode).toBe(200);
    expect((await stored()).serviceIds).toEqual([bathId]);

    const emptied = await app.inject({
      method: "PUT", url: `/api/employees/${employeeId}`, headers: { cookie: ownerCookie },
      payload: { serviceIds: [] }
    });
    expect(emptied.statusCode).toBe(200);
    expect((await stored()).serviceIds).toEqual([]);
    // Clearing the restriction must not have taken the account link with it.
    expect((await stored()).membershipId).toBe(membershipId);
  });

  it("refuses an edit that names no field at all", async () => {
    const empty = await app.inject({
      method: "PUT", url: `/api/employees/${employeeId}`, headers: { cookie: ownerCookie },
      payload: {}
    });
    expect(empty.statusCode).toBe(400);
  });
});
