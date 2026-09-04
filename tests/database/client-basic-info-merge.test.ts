import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * `PUT /api/customers/:id` is a MERGE, and an omitted field is not an instruction to clear one.
 *
 * The regression these cover is not hypothetical. The handler wrote every optional column
 * unconditionally - `address=${input.address ?? null}` and friends - while the Basic info form
 * has never carried an address field, because addresses live in their own panel. Every save of a
 * client's name therefore emptied `customers.address`, the mirror migration 0025 maintains over
 * `customer_addresses` on the stated invariant that the two "cannot drift, because only one of
 * them is ever written by hand". This handler was the second hand.
 *
 * The same shape sat on the two fields carrying a schema `.default()`: omitting
 * `preferredContactMethod` reset every client to email, and omitting `emailAllowed` switched
 * marketing email back on for a client who had opted out. A default turns an absent field into a
 * value, which is the same silent write in a quieter form.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "client-basic-info-secret-at-least-thirty-two",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("client Basic info is a merge, not a replace", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string, businessId: string;
  const suffix = crypto.randomUUID();

  const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie: ownerCookie }, ...(payload ? { payload } : {}) });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });

  /** The stored row, read past the API so a handler cannot report a value it did not persist. */
  const stored = async (id: string) => {
    const [row] = await db<{
      firstName: string | null; lastName: string | null; phone: string | null;
      normalizedPhone: string | null; email: string | null; normalizedEmail: string | null;
      address: string | null; preferredContactMethod: string | null; emailAllowed: boolean;
      notes: string | null;
    }[]>`
      select first_name,last_name,phone,normalized_phone,email,normalized_email,address,
        preferred_contact_method,email_allowed,notes
      from customers where business_id=${businessId} and id=${id}
    `;
    return row!;
  };

  const addresses = async (id: string) =>
    (await get(`/api/customers/${id}/addresses`)).json().items as
      { id: string; address: string; isPrimary: boolean; label: string | null }[];

  /** A client with every optional field populated, so any silent clear has something to destroy. */
  const fullyPopulatedClient = async (name: string) => {
    const created = await send("POST", "/api/customers", {
      firstName: name, lastName: "Vasquez", phone: "(215) 555-0142",
      email: `${name.toLowerCase()}-${suffix}@example.test`,
      preferredContactMethod: "phone", emailAllowed: false, notes: "Prefers a morning slot."
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const address = await send("POST", `/api/customers/${id}/addresses`, {
      address: "12 Chestnut Street, Philadelphia, PA", label: "Home"
    });
    expect(address.statusCode, address.body).toBe(201);
    return id;
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `basic-info-${suffix}@example.test`,
      password: "correct horse basic info merge", businessName: `Basic Info Salon ${suffix}`
    }});
    ownerCookie = cookie(signup);
    ({ businessId } = signup.json());
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it("leaves a stored address alone when Basic info is saved without one", async () => {
    const id = await fullyPopulatedClient("Rosa");
    expect((await stored(id)).address).toBe("12 Chestnut Street, Philadelphia, PA");

    // Exactly what the Basic info form sends: no address field at all.
    const saved = await send("PUT", `/api/customers/${id}`, {
      firstName: "Rosa", lastName: "Vasquez", phone: "(215) 555-0142",
      email: `rosa-${suffix}@example.test`, preferredContactMethod: "phone", emailAllowed: false
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().address).toBe("12 Chestnut Street, Philadelphia, PA");
    expect((await stored(id)).address).toBe("12 Chestnut Street, Philadelphia, PA");
    // The list the mirror is derived from is equally untouched: no row was deleted or added.
    expect(await addresses(id)).toMatchObject([
      { address: "12 Chestnut Street, Philadelphia, PA", label: "Home", isPrimary: true }
    ]);
  });

  it("leaves every other omitted field alone as well", async () => {
    const id = await fullyPopulatedClient("Marisol");
    const before = await stored(id);
    // A payload naming only the field being changed. The "at least a name, a phone number, or an
    // email" rule is a check on the payload, so `firstName` is what carries this one.
    const saved = await send("PUT", `/api/customers/${id}`, { firstName: "Marisol Renata" });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = await stored(id);
    expect(after.firstName).toBe("Marisol Renata");
    expect(after).toMatchObject({
      lastName: before.lastName,
      phone: before.phone,
      normalizedPhone: before.normalizedPhone,
      email: before.email,
      normalizedEmail: before.normalizedEmail,
      address: before.address,
      // Both of these were reset by a schema `.default()` rather than by a `?? null`, which is
      // the same defect wearing a different hat.
      preferredContactMethod: "phone",
      emailAllowed: false,
      notes: before.notes
    });
  });

  it("still writes an address the caller actually sends, through the address list", async () => {
    const id = await fullyPopulatedClient("Ines");
    const saved = await send("PUT", `/api/customers/${id}`, {
      firstName: "Ines", address: "88 Shore Road, Margate, NJ"
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().address).toBe("88 Shore Road, Margate, NJ");
    expect((await stored(id)).address).toBe("88 Shore Road, Margate, NJ");
    // Edited IN PLACE. The mirror and the panel must not disagree, and a legacy write must not
    // leave a second address row behind for the operator to reconcile.
    const list = await addresses(id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ address: "88 Shore Road, Margate, NJ", isPrimary: true, label: "Home" });
  });

  it("clears the address on an explicit empty value, and on an explicit null", async () => {
    for (const clearing of ["", null]) {
      const id = await fullyPopulatedClient(`Elena${clearing === "" ? "Blank" : "Null"}`);
      const saved = await send("PUT", `/api/customers/${id}`, { firstName: "Elena", address: clearing });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().address).toBeNull();
      expect((await stored(id)).address).toBeNull();
      expect(await addresses(id)).toHaveLength(0);
    }
  });

  it("clears the other optional fields on an explicit null and keeps the search columns in step", async () => {
    const id = await fullyPopulatedClient("Priya");
    const saved = await send("PUT", `/api/customers/${id}`, {
      firstName: "Priya", lastName: null, phone: null, email: null
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = await stored(id);
    expect(after).toMatchObject({
      firstName: "Priya", lastName: null, phone: null, email: null
    });
    // A record must never stay findable by a number it no longer holds.
    expect(after.normalizedPhone).toBeNull();
    expect(after.normalizedEmail).toBeNull();
  });

  it("promotes the next address when the legacy field clears a primary with siblings behind it", async () => {
    const id = await fullyPopulatedClient("Dara");
    const second = await send("POST", `/api/customers/${id}/addresses`, {
      address: "5 Ferry Lane, Camden, NJ", label: "Work"
    });
    expect(second.statusCode, second.body).toBe(201);
    const cleared = await send("PUT", `/api/customers/${id}`, { firstName: "Dara", address: "" });
    expect(cleared.statusCode, cleared.body).toBe(200);
    // Same rule as `DELETE /api/customers/:id/addresses/:childId`: a client with addresses on file
    // and no primary has no answer to "where do we go?".
    const list = await addresses(id);
    expect(list).toMatchObject([{ address: "5 Ferry Lane, Camden, NJ", isPrimary: true }]);
    expect((await stored(id)).address).toBe("5 Ferry Lane, Camden, NJ");
  });

  it("creates a client's address in the list rather than only in the mirror", async () => {
    const created = await send("POST", "/api/customers", {
      firstName: "Nadia", phone: "(215) 555-0188", address: "31 Pine Street, Philadelphia, PA"
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    expect(created.json().address).toBe("31 Pine Street, Philadelphia, PA");
    // Written by hand into the column, this address was invisible in the Addresses panel and was
    // silently replaced by the first address anybody added there.
    expect(await addresses(id)).toMatchObject([
      { address: "31 Pine Street, Philadelphia, PA", isPrimary: true }
    ]);
  });

  it("keeps the create-time defaults for a client that names neither preference", async () => {
    const created = await send("POST", "/api/customers", {
      firstName: "Tomas", phone: "(215) 555-0199"
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(await stored(created.json().id)).toMatchObject({
      preferredContactMethod: "email", emailAllowed: true
    });
  });
});
