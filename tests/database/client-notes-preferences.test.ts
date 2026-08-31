import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test",
  DOCUMENT_STORAGE_ADAPTER: "memory",
  PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "client-notes-test-secret-at-least-32-characters",
  APP_ORIGIN: "http://localhost:3000",
  SMTP_PORT: 587,
  SMTP_SECURE: false
};
const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

interface NoteRow {
  id: string;
  customerId: string;
  body: string;
  pinned: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  authorName: string;
}

interface PreferenceRow {
  id: string;
  bookingFrequencyWeeks: number | null;
  blockMessages: boolean;
  blockOnlineBooking: boolean;
  marketingSmsAllowed: boolean;
  emailAllowed: boolean;
}

describeDatabase("client note thread and client preferences", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  const ownerEmail = `notes-owner-${suffix}@example.test`;
  const ownerPassword = "correct horse client notes battery";
  const origin = config.APP_ORIGIN;
  let ownerCookie: string;
  let viewerCookie: string;
  let strangerCookie: string;
  let otherOwnerCookie: string;
  let businessId: string;
  let otherBusinessId: string;
  let customerId: string;
  let otherCustomerId: string;

  const legacyNotes = "Prefers morning drop-off.";

  const createMember = async (label: string, memberPermissions: string[]) => {
    const email = `${label}-${suffix}@example.test`;
    const password = `correct horse ${label} battery`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash,display_name)
      values (${email},${email},${await hashPassword(password)},${label}) returning id
    `;
    await db`
      insert into business_memberships(business_id,user_id,permissions)
      values (${businessId},${user!.id},${memberPermissions})
    `;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    expect(login.statusCode).toBe(200);
    return cookie(login);
  };

  const listNotes = async (cookieValue = ownerCookie, customer = customerId) => {
    const response = await app.inject({
      method: "GET", url: `/api/customers/${customer}/notes`, headers: { cookie: cookieValue }
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { items: NoteRow[]; total: number; page: number; pageSize: number };
  };

  const legacyColumn = async (customer = customerId) => {
    const [row] = await db<{ notes: string | null }[]>`
      select notes from customers where business_id=${businessId} and id=${customer}
    `;
    return row?.notes ?? null;
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: ownerEmail, password: ownerPassword, businessName: "Note Thread Salon" }
    });
    expect(signup.statusCode).toBe(201);
    ownerCookie = cookie(signup);
    businessId = signup.json().businessId;

    const created = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie, origin },
      payload: { firstName: "Robin", lastName: "Vale", email: `robin-${suffix}@example.test`, notes: legacyNotes }
    });
    expect(created.statusCode).toBe(201);
    customerId = created.json().id;

    viewerCookie = await createMember("viewer", ["customers.view"]);
    strangerCookie = await createMember("stranger", ["calendar.view"]);

    const other = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `notes-other-${suffix}@example.test`,
        password: "correct horse other salon battery", businessName: "Other Salon"
      }
    });
    expect(other.statusCode).toBe(201);
    otherBusinessId = other.json().businessId;
    otherOwnerCookie = cookie(other);
    const otherCustomer = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: cookie(other), origin },
      payload: { firstName: "Not", lastName: "Yours" }
    });
    expect(otherCustomer.statusCode).toBe(201);
    otherCustomerId = otherCustomer.json().id;
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  describe("note thread", () => {
    it("routes the legacy single notes field into the thread as the first note", async () => {
      const thread = await listNotes();
      expect(thread.total).toBe(1);
      expect(thread.items[0]).toMatchObject({ body: legacyNotes, pinned: false, customerId });
      // The author resolves to a displayable name rather than a bare user id.
      expect(thread.items[0]!.authorName).toBe(ownerEmail.split("@")[0]);
      expect(await legacyColumn()).toBe(legacyNotes);
    });

    it("backfills a pre-existing customers.notes value into the thread", async () => {
      // Reproduces the 0019 backfill against a row written the way the legacy schema wrote it.
      const migration = await readFile("migrations/0019_client_notes_and_preferences.sql", "utf8");
      expect(migration).toContain("insert into customer_notes (business_id, customer_id, body, created_by, created_at, updated_at)");
      const [legacyCustomer] = await db<{ id: string; createdAt: Date }[]>`
        insert into customers(business_id,first_name,last_name,notes,created_by,updated_by)
        values (${businessId},'Legacy','Row',${"  Old free text  "},
          (select id from users where normalized_email=${ownerEmail}),
          (select id from users where normalized_email=${ownerEmail}))
        returning id,created_at
      `;
      await db`
        insert into customer_notes (business_id, customer_id, body, created_by, created_at, updated_at)
        select business_id, id, left(btrim(notes), 5000), created_by, created_at, updated_at
        from customers
        where business_id=${businessId} and id=${legacyCustomer!.id}
          and notes is not null and btrim(notes) <> ''
      `;
      const thread = await listNotes(ownerCookie, legacyCustomer!.id);
      expect(thread.total).toBe(1);
      expect(thread.items[0]!.body).toBe("Old free text");
      expect(new Date(thread.items[0]!.createdAt).getTime())
        .toBe(legacyCustomer!.createdAt.getTime());
      // The mirror trigger keeps the legacy column agreeing with the thread.
      expect(await legacyColumn(legacyCustomer!.id)).toBe("Old free text");
    });

    it("creates notes with an author display name and a popup flag", async () => {
      const [membership] = await db<{ id: string }[]>`
        select membership.id from business_memberships membership
        join users account on account.id=membership.user_id
        where membership.business_id=${businessId} and account.normalized_email=${ownerEmail}
      `;
      await db`
        insert into employees(business_id,membership_id,display_name)
        values (${businessId},${membership!.id},'Front Desk')
      `;
      const created = await app.inject({
        method: "POST", url: `/api/customers/${customerId}/notes`,
        headers: { cookie: ownerCookie, origin },
        payload: { body: "Needs email address.", pinned: true }
      });
      expect(created.statusCode).toBe(201);
      const note = created.json() as NoteRow;
      expect(note).toMatchObject({ body: "Needs email address.", pinned: true, customerId });
      // The business-scoped employee name wins over the bare account name.
      expect(note.authorName).toBe("Front Desk");
      expect(typeof note.createdAt).toBe("string");
    });

    it("orders popup notes first and then newest first", async () => {
      const plain = await app.inject({
        method: "POST", url: `/api/customers/${customerId}/notes`,
        headers: { cookie: ownerCookie, origin }, payload: { body: "Called about rebooking." }
      });
      expect(plain.statusCode).toBe(201);
      const thread = await listNotes();
      expect(thread.total).toBe(3);
      expect(thread.items.map((item) => item.body)).toEqual([
        "Needs email address.", "Called about rebooking.", legacyNotes
      ]);
      expect(thread.items[0]!.pinned).toBe(true);
    });

    it("mirrors the newest note onto the legacy customers.notes column", async () => {
      expect(await legacyColumn()).toBe("Called about rebooking.");
      const history = await app.inject({
        method: "GET", url: `/api/customers/${customerId}/history`, headers: { cookie: ownerCookie }
      });
      expect(history.statusCode).toBe(200);
      // The pre-existing response key still exists and still carries text.
      expect(history.json().customer.notes).toBe("Called about rebooking.");
    });

    it("updates a note body and popup flag", async () => {
      const thread = await listNotes();
      const target = thread.items.find((item) => item.body === "Called about rebooking.")!;
      const updated = await app.inject({
        method: "PATCH", url: `/api/customers/${customerId}/notes/${target.id}`,
        headers: { cookie: ownerCookie, origin }, payload: { body: "Called about rebooking in June.", pinned: true }
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ id: target.id, body: "Called about rebooking in June.", pinned: true });
      expect(await legacyColumn()).toBe("Called about rebooking in June.");
      const rejected = await app.inject({
        method: "PATCH", url: `/api/customers/${customerId}/notes/${target.id}`,
        headers: { cookie: ownerCookie, origin }, payload: {}
      });
      expect(rejected.statusCode).toBe(400);
    });

    it("edits the newest note through the legacy customer form instead of duplicating it", async () => {
      const before = await listNotes();
      const saved = await app.inject({
        method: "PUT", url: `/api/customers/${customerId}`, headers: { cookie: ownerCookie, origin },
        payload: {
          firstName: "Robin", lastName: "Vale", email: `robin-${suffix}@example.test`,
          notes: "Called about rebooking in July."
        }
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().notes).toBe("Called about rebooking in July.");
      const after = await listNotes();
      expect(after.total).toBe(before.total);
      expect(after.items.some((item) => item.body === "Called about rebooking in July.")).toBe(true);
    });

    it("removes the note the legacy field represents when that field is cleared", async () => {
      const before = await listNotes();
      const cleared = await app.inject({
        method: "PUT", url: `/api/customers/${customerId}`, headers: { cookie: ownerCookie, origin },
        payload: { firstName: "Robin", lastName: "Vale", email: `robin-${suffix}@example.test`, notes: "" }
      });
      expect(cleared.statusCode).toBe(200);
      const after = await listNotes();
      expect(after.total).toBe(before.total - 1);
      // The mirror falls back to whichever note is now newest rather than going stale.
      // Ordering of the mirror is by age only; pinning affects thread display, not the mirror.
      const newest = [...after.items].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      )[0]!;
      expect(cleared.json().notes).toBe(newest.body);
      expect(await legacyColumn()).toBe(cleared.json().notes);
    });

    it("deletes a note and keeps the mirror consistent", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/customers/${customerId}/notes`,
        headers: { cookie: ownerCookie, origin }, payload: { body: "Temporary note." }
      });
      expect(created.statusCode).toBe(201);
      expect(await legacyColumn()).toBe("Temporary note.");
      const removed = await app.inject({
        method: "DELETE", url: `/api/customers/${customerId}/notes/${created.json().id}`,
        headers: { cookie: ownerCookie, origin }
      });
      expect(removed.statusCode).toBe(204);
      const thread = await listNotes();
      expect(thread.items.some((item) => item.body === "Temporary note.")).toBe(false);
      expect(await legacyColumn()).not.toBe("Temporary note.");
    });

    it("rejects an empty or oversized note body", async () => {
      const empty = await app.inject({
        method: "POST", url: `/api/customers/${customerId}/notes`,
        headers: { cookie: ownerCookie, origin }, payload: { body: "   " }
      });
      expect(empty.statusCode).toBe(400);
      const oversized = await app.inject({
        method: "POST", url: `/api/customers/${customerId}/notes`,
        headers: { cookie: ownerCookie, origin }, payload: { body: "x".repeat(5001) }
      });
      expect(oversized.statusCode).toBe(400);
    });

    it("gates reads on customers.view and writes on customers.edit", async () => {
      expect((await app.inject({
        method: "GET", url: `/api/customers/${customerId}/notes`, headers: { cookie: viewerCookie }
      })).statusCode).toBe(200);
      const thread = await listNotes();
      const target = thread.items[0]!;
      const denials: Array<{ method: "POST" | "PATCH" | "DELETE"; url: string; payload: Record<string, unknown> }> = [
        { method: "POST", url: `/api/customers/${customerId}/notes`, payload: { body: "Nope." } },
        { method: "PATCH", url: `/api/customers/${customerId}/notes/${target.id}`, payload: { pinned: false } },
        { method: "DELETE", url: `/api/customers/${customerId}/notes/${target.id}`, payload: {} }
      ];
      for (const attempt of denials) {
        const response = await app.inject({
          method: attempt.method, url: attempt.url,
          headers: { cookie: viewerCookie, origin }, payload: attempt.payload
        });
        expect(response.statusCode).toBe(403);
      }
      expect((await app.inject({
        method: "GET", url: `/api/customers/${customerId}/notes`, headers: { cookie: strangerCookie }
      })).statusCode).toBe(403);
      expect((await app.inject({
        method: "GET", url: `/api/customers/${customerId}/notes`
      })).statusCode).toBe(401);
    });

    it("never exposes or accepts another business's notes", async () => {
      const thread = await listNotes();
      const target = thread.items[0]!;
      const foreign = otherOwnerCookie;
      expect((await app.inject({
        method: "GET", url: `/api/customers/${customerId}/notes`, headers: { cookie: foreign }
      })).statusCode).toBe(404);
      expect((await app.inject({
        method: "POST", url: `/api/customers/${customerId}/notes`,
        headers: { cookie: foreign, origin }, payload: { body: "Cross tenant." }
      })).statusCode).toBe(404);
      expect((await app.inject({
        method: "PATCH", url: `/api/customers/${customerId}/notes/${target.id}`,
        headers: { cookie: foreign, origin }, payload: { pinned: false }
      })).statusCode).toBe(404);
      expect((await app.inject({
        method: "DELETE", url: `/api/customers/${customerId}/notes/${target.id}`,
        headers: { cookie: foreign, origin }
      })).statusCode).toBe(404);
      // The note survived every cross-tenant attempt.
      const after = await listNotes();
      expect(after.items.find((item) => item.id === target.id)).toMatchObject({ pinned: target.pinned });
      // A note addressed with the wrong customer id in the same tenant is also refused.
      expect((await app.inject({
        method: "DELETE", url: `/api/customers/${otherCustomerId}/notes/${target.id}`,
        headers: { cookie: foreign, origin }
      })).statusCode).toBe(404);
    });

    it("refuses at the database layer to attach a note across tenants", async () => {
      await expect(db`
        insert into customer_notes(business_id,customer_id,body)
        values (${otherBusinessId},${customerId},'Cross tenant row')
      `).rejects.toMatchObject({ code: "23503" });
    });

    it("refuses to move a note between customers", async () => {
      const thread = await listNotes();
      await expect(db`
        update customer_notes set customer_id=${otherCustomerId}
        where business_id=${businessId} and id=${thread.items[0]!.id}
      `).rejects.toThrow(/immutable|violates foreign key/);
    });
  });

  describe("client preferences", () => {
    const read = async (customer = customerId) => {
      const response = await app.inject({
        method: "GET", url: `/api/customers/${customer}/history`, headers: { cookie: ownerCookie }
      });
      expect(response.statusCode).toBe(200);
      return response.json().customer as PreferenceRow;
    };

    it("defaults every switch on the customer record", async () => {
      expect(await read()).toMatchObject({
        bookingFrequencyWeeks: null,
        blockMessages: false,
        blockOnlineBooking: false,
        marketingSmsAllowed: true,
        emailAllowed: true
      });
    });

    it("updates only the switches the request names", async () => {
      const response = await app.inject({
        method: "PATCH", url: `/api/customers/${customerId}/preferences`,
        headers: { cookie: ownerCookie, origin },
        payload: { bookingFrequencyWeeks: 6, blockMessages: true }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: customerId, bookingFrequencyWeeks: 6, blockMessages: true,
        blockOnlineBooking: false, marketingSmsAllowed: true, emailAllowed: true
      });
      expect(typeof response.json().bookingFrequencyWeeks).toBe("number");
      const followUp = await app.inject({
        method: "PATCH", url: `/api/customers/${customerId}/preferences`,
        headers: { cookie: ownerCookie, origin }, payload: { marketingSmsAllowed: false }
      });
      expect(followUp.json()).toMatchObject({
        bookingFrequencyWeeks: 6, blockMessages: true, marketingSmsAllowed: false
      });
    });

    it("reuses the existing email_allowed column rather than duplicating it", async () => {
      const response = await app.inject({
        method: "PATCH", url: `/api/customers/${customerId}/preferences`,
        headers: { cookie: ownerCookie, origin }, payload: { emailAllowed: false }
      });
      expect(response.statusCode).toBe(200);
      const [row] = await db<{ emailAllowed: boolean }[]>`
        select email_allowed from customers where business_id=${businessId} and id=${customerId}
      `;
      expect(row?.emailAllowed).toBe(false);
      // Restore it through the pre-existing customer form path to prove one column, two doors.
      const saved = await app.inject({
        method: "PUT", url: `/api/customers/${customerId}`, headers: { cookie: ownerCookie, origin },
        payload: {
          firstName: "Robin", lastName: "Vale", email: `robin-${suffix}@example.test`,
          emailAllowed: true, notes: "Called about rebooking in July."
        }
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().emailAllowed).toBe(true);
    });

    it("leaves preferences untouched when the legacy customer form is saved", async () => {
      const before = await read();
      const saved = await app.inject({
        method: "PUT", url: `/api/customers/${customerId}`, headers: { cookie: ownerCookie, origin },
        payload: {
          firstName: "Robin", lastName: "Vale", email: `robin-${suffix}@example.test`,
          notes: "Called about rebooking in July."
        }
      });
      expect(saved.statusCode).toBe(200);
      expect(await read()).toMatchObject({
        bookingFrequencyWeeks: before.bookingFrequencyWeeks,
        blockMessages: before.blockMessages,
        blockOnlineBooking: before.blockOnlineBooking,
        marketingSmsAllowed: before.marketingSmsAllowed
      });
    });

    it("clears the rebooking cadence with an explicit null", async () => {
      const response = await app.inject({
        method: "PATCH", url: `/api/customers/${customerId}/preferences`,
        headers: { cookie: ownerCookie, origin }, payload: { bookingFrequencyWeeks: null }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().bookingFrequencyWeeks).toBeNull();
      expect(response.json().blockMessages).toBe(true);
    });

    it("stores block_online_booking even though nothing enforces it yet", async () => {
      const response = await app.inject({
        method: "PATCH", url: `/api/customers/${customerId}/preferences`,
        headers: { cookie: ownerCookie, origin }, payload: { blockOnlineBooking: true }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().blockOnlineBooking).toBe(true);
      expect((await read()).blockOnlineBooking).toBe(true);
    });

    it("rejects out-of-range and empty preference requests", async () => {
      for (const payload of [
        { bookingFrequencyWeeks: 0 }, { bookingFrequencyWeeks: 105 },
        { bookingFrequencyWeeks: 2.5 }, { blockMessages: "yes" }, {}, { unknownSwitch: true }
      ]) {
        const response = await app.inject({
          method: "PATCH", url: `/api/customers/${customerId}/preferences`,
          headers: { cookie: ownerCookie, origin }, payload
        });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
    });

    it("gates preference writes on customers.edit and on tenancy", async () => {
      expect((await app.inject({
        method: "PATCH", url: `/api/customers/${customerId}/preferences`,
        headers: { cookie: viewerCookie, origin }, payload: { blockMessages: false }
      })).statusCode).toBe(403);
      expect((await app.inject({
        method: "PATCH", url: `/api/customers/${customerId}/preferences`,
        headers: { cookie: otherOwnerCookie, origin }, payload: { blockMessages: false }
      })).statusCode).toBe(404);
      expect((await read()).blockMessages).toBe(true);
    });

    it("refuses preference writes on an archived customer", async () => {
      const archivable = await app.inject({
        method: "POST", url: "/api/customers", headers: { cookie: ownerCookie, origin },
        payload: { firstName: "Archived", lastName: "Client" }
      });
      expect(archivable.statusCode).toBe(201);
      const archivedId = archivable.json().id;
      expect((await app.inject({
        method: "POST", url: `/api/customers/${archivedId}/archive`,
        headers: { cookie: ownerCookie, origin }
      })).statusCode).toBe(204);
      expect((await app.inject({
        method: "PATCH", url: `/api/customers/${archivedId}/preferences`,
        headers: { cookie: ownerCookie, origin }, payload: { blockMessages: true }
      })).statusCode).toBe(404);
      expect((await app.inject({
        method: "POST", url: `/api/customers/${archivedId}/notes`,
        headers: { cookie: ownerCookie, origin }, payload: { body: "Too late." }
      })).statusCode).toBe(404);
      // Reading an archived client's thread is still allowed.
      expect((await app.inject({
        method: "GET", url: `/api/customers/${archivedId}/notes`, headers: { cookie: ownerCookie }
      })).statusCode).toBe(200);
    });

    it("keeps the customer directory response keys unchanged", async () => {
      const response = await app.inject({
        method: "GET", url: "/api/customers", headers: { cookie: ownerCookie }
      });
      expect(response.statusCode).toBe(200);
      const rows = response.json() as Record<string, unknown>[];
      const row = rows.find((entry) => entry.id === customerId)!;
      expect(row).toHaveProperty("notes");
      expect(row).toHaveProperty("emailAllowed");
      expect(row).toHaveProperty("archivedAt");
      const paged = await app.inject({
        method: "GET", url: "/api/customers?paged=true", headers: { cookie: ownerCookie }
      });
      expect(paged.statusCode).toBe(200);
      expect(paged.json()).toMatchObject({ page: 1, pageSize: 20 });
      expect(Object.keys(paged.json().items[0] as Record<string, unknown>)).toEqual(
        expect.arrayContaining(["id", "firstName", "lastName", "phone", "email", "archivedAt",
          "lastVisit", "nextAppointment", "preferredEmployeeId", "preferredEmployeeName", "pets"])
      );
    });
  });
});
