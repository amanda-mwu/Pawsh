import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "client-contacts-secret-at-least-thirty-two-ch",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("client addresses and contacts", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string, businessId: string, customerId: string;

  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
  const send = (method: "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie: ownerCookie }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `contacts-${crypto.randomUUID()}@example.test`,
      password: "correct horse client contacts", businessName: "Contacts Salon"
    }});
    ownerCookie = cookie(signup);
    ({ businessId } = signup.json());
    customerId = (await send("POST", "/api/customers", {
      firstName: "Abhay", lastName: "Kshir", phone: "(267) 320-4180"
    })).json().id;
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it("makes the first address primary without being asked", async () => {
    const created = await send("POST", `/api/customers/${customerId}/addresses`, {
      address: "12 Chestnut Street, Philadelphia, PA"
    });
    expect(created.statusCode, created.body).toBe(201);
    // A list of one with no primary would leave the mirrored column empty for no reason.
    expect(created.json().items[0]).toMatchObject({ isPrimary: true });
  });

  it("keeps exactly one primary address and mirrors it onto the client", async () => {
    const second = await send("POST", `/api/customers/${customerId}/addresses`, {
      address: "88 Shore Road, Margate, NJ", label: "Summer", isPrimary: true
    });
    expect(second.statusCode, second.body).toBe(201);
    const items = second.json().items;
    expect(items.filter((item: { isPrimary: boolean }) => item.isPrimary)).toHaveLength(1);
    expect(items[0]).toMatchObject({ address: "88 Shore Road, Margate, NJ", isPrimary: true });

    // `customers.address` is a derived mirror, so existing readers stay correct and the two
    // cannot drift.
    const [customer] = await db<{ address: string | null }[]>`
      select address from customers where business_id=${businessId} and id=${customerId}
    `;
    expect(customer!.address).toBe("88 Shore Road, Margate, NJ");
  });

  it("promotes the next address when the primary is deleted", async () => {
    const listed = (await get(`/api/customers/${customerId}/addresses`)).json().items;
    const primary = listed.find((item: { isPrimary: boolean }) => item.isPrimary);
    const removed = await send("DELETE", `/api/customers/${customerId}/addresses/${primary.id}`);
    expect(removed.statusCode, removed.body).toBe(200);
    // Several addresses and no answer to "where do we go?" would be worse than none.
    expect(removed.json().items.filter((item: { isPrimary: boolean }) => item.isPrimary)).toHaveLength(1);
    const [customer] = await db<{ address: string | null }[]>`
      select address from customers where business_id=${businessId} and id=${customerId}
    `;
    expect(customer!.address).toBe("12 Chestnut Street, Philadelphia, PA");
  });

  it("keeps several contacts with exactly one primary", async () => {
    const owner = await send("POST", `/api/customers/${customerId}/contacts`, {
      name: "Abhay Kshir", phone: "(267) 320-4180", title: "Owner"
    });
    expect(owner.statusCode, owner.body).toBe(201);
    expect(owner.json().items[0]).toMatchObject({ isPrimary: true, receivesAutomatedMessages: true });

    const walker = await send("POST", `/api/customers/${customerId}/contacts`, {
      name: "Dana Reeve", phone: "(267) 555-0142", title: "Dog walker",
      receivesAutomatedMessages: false
    });
    expect(walker.statusCode, walker.body).toBe(201);
    const items = walker.json().items;
    expect(items).toHaveLength(2);
    expect(items.filter((item: { isPrimary: boolean }) => item.isPrimary)).toHaveLength(1);

    const walkerRow = items.find((item: { name: string }) => item.name === "Dana Reeve");
    const promoted = await send("PATCH", `/api/customers/${customerId}/contacts/${walkerRow.id}`, {
      isPrimary: true
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    // Promoting demotes the incumbent in the same transaction; the partial unique index would
    // otherwise reject the second primary.
    const after = promoted.json().items;
    expect(after.filter((item: { isPrimary: boolean }) => item.isPrimary)).toHaveLength(1);
    expect(after[0]).toMatchObject({ name: "Dana Reeve", isPrimary: true });
  });

  it("reports that nothing acts on the automated-message flag", async () => {
    const listed = await get(`/api/customers/${customerId}/contacts`);
    expect(listed.statusCode).toBe(200);
    // Said in the payload as well as the interface: Pawsh has no SMS transport, and a caller
    // must not read the flag as a message being sent.
    expect(listed.json().automatedMessagesSupported).toBe(false);
  });

  it("normalises contact phone numbers so they can be searched", async () => {
    const [contact] = await db<{ normalizedPhone: string | null }[]>`
      select normalized_phone from customer_contacts
      where business_id=${businessId} and name='Dana Reeve'
    `;
    expect(contact!.normalizedPhone).toBe("2675550142");
  });

  it("refuses a contact with no name or no phone", async () => {
    for (const payload of [{ name: "No Phone" }, { phone: "(267) 555-0001" }, { name: " ", phone: " " }]) {
      const refused = await send("POST", `/api/customers/${customerId}/contacts`, payload);
      expect(refused.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("keeps addresses and contacts inside their own tenant", async () => {
    const foreign = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `foreign-contacts-${crypto.randomUUID()}@example.test`,
      password: "correct horse foreign contacts", businessName: "Foreign Contacts Salon"
    }});
    for (const url of [
      `/api/customers/${customerId}/addresses`, `/api/customers/${customerId}/contacts`
    ]) {
      const denied = await app.inject({ method: "GET", url, headers: { cookie: cookie(foreign) } });
      expect([403, 404], url).toContain(denied.statusCode);
    }
  });
});
