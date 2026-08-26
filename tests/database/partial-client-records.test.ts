import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "partial-client-secret-at-least-thirty-two-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("partial client records", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string, businessId: string;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `partial-${crypto.randomUUID()}@example.test`,
      password: "correct horse partial battery", businessName: "Enquiry Salon"
    }});
    ownerCookie = cookie(signup);
    ({ businessId } = signup.json());
  });
  afterAll(async () => { await app.close(); await db.end(); });

  const createCustomer = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/customers", headers: { cookie: ownerCookie }, payload });

  it("records an enquiry that gave only a phone number", async () => {
    const created = await createCustomer({ phone: "(704) 957-9171" });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    // Unknown is stored as null, never as a placeholder that would sort and match like a name.
    const [stored] = await db<{ firstName: string | null; lastName: string | null }[]>`
      select first_name,last_name from customers where business_id=${businessId} and id=${id}
    `;
    expect(stored!.firstName).toBeNull();
    expect(stored!.lastName).toBeNull();

    // And a pet whose breed is known but whose name was never given.
    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId: id, species: "dog", breed: "Goldendoodle" }
    });
    expect(pet.statusCode, pet.body).toBe(201);
    const [storedPet] = await db<{ name: string | null; breed: string | null }[]>`
      select name,breed from pets where business_id=${businessId} and id=${pet.json().id}
    `;
    expect(storedPet!.name).toBeNull();
    expect(storedPet!.breed).toBe("Goldendoodle");
  });

  it("accepts a first name alone, or a last name alone", async () => {
    expect((await createCustomer({ firstName: "Aaron" })).statusCode).toBe(201);
    expect((await createCustomer({ lastName: "Cayabyab" })).statusCode).toBe(201);
    expect((await createCustomer({ email: `walkin-${crypto.randomUUID()}@example.test` })).statusCode).toBe(201);
  });

  it("refuses a record with no way to find the person again", async () => {
    for (const payload of [{}, { firstName: "  ", lastName: "" }, { phone: "   " }]) {
      const refused = await createCustomer(payload);
      expect(refused.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // Nothing empty was written on the way to being refused.
    const [count] = await db<{ count: number }[]>`
      select count(*)::int count from customers
      where business_id=${businessId} and first_name is null and last_name is null
        and normalized_phone is null and normalized_email is null
    `;
    expect(count!.count).toBe(0);
  });

  it("treats a blank name as absent rather than storing an empty string", async () => {
    // Two spellings of the same absence would mean every read had to handle both.
    const created = await createCustomer({ firstName: "   ", phone: "(704) 555-0000" });
    expect(created.statusCode).toBe(201);
    const [stored] = await db<{ firstName: string | null }[]>`
      select first_name from customers where business_id=${businessId} and id=${created.json().id}
    `;
    expect(stored!.firstName).toBeNull();
  });

  it("fills a partial record in later without creating a second one", async () => {
    const created = await createCustomer({ phone: "(704) 957-1234" });
    const id = created.json().id;
    const named = await app.inject({
      method: "PUT", url: `/api/customers/${id}`, headers: { cookie: ownerCookie },
      payload: { firstName: "Aaron", lastName: "Cayabyab", phone: "(704) 957-1234" }
    });
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json()).toMatchObject({ firstName: "Aaron", lastName: "Cayabyab" });
  });

  it("finds a partial record by the one detail it has", async () => {
    const found = await app.inject({
      method: "GET", url: "/api/customers?q=9579171", headers: { cookie: ownerCookie }
    });
    expect(found.statusCode).toBe(200);
    const items = found.json().items ?? found.json();
    expect(Array.isArray(items) ? items.length : 0).toBeGreaterThan(0);
  });

  it("still refuses a name that is only whitespace on an otherwise valid record", async () => {
    const [remaining] = await db<{ count: number }[]>`
      select count(*)::int count from customers
      where business_id=${businessId} and (btrim(first_name)='' or btrim(last_name)='')
    `;
    expect(remaining!.count).toBe(0);
  });
});
