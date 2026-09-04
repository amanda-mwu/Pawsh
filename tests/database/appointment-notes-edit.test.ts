import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissionPresets } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { roleFor } from "../support/roles.js";

/**
 * THE BOOKING NOTE IS EDITABLE, AND EDITING IT IS NOT A FINANCIAL EVENT.
 *
 * `appointments.notes` was written once by `POST /api/appointments` and never again, because no
 * route existed to write it a second time. That was an absent route rather than a decision, and
 * `PATCH /api/appointments/:id` closes it. This file states the resulting contract:
 *
 *   - the note is the same field, under the same rules, at booking and afterwards;
 *   - it stays editable after completion, after invoicing and after payment, so a typo is
 *     correctable without cancelling and rebooking a visit somebody has already paid for;
 *   - and the edit moves no money. The last case is the reason the file exists: it takes a
 *     complete financial fingerprint of a discounted, taxed, tipped, part-credit-paid invoice,
 *     edits the note, and asserts the fingerprint is unchanged value for value.
 *
 * `operational_notes` is a different column with a different audience and is not touched here or
 * by the route: it stays on `PATCH /api/appointments/:id/operations` under
 * `operations.perform_service`.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "appointment-notes-edit-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

const servicePriceMinor = 10_000;
const taxRateBasisPoints = 875;

describeDatabase("editing the appointment note", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();

  let ownerCookie = "";
  let managerCookie = "";
  let receptionistCookie = "";
  let groomerCookie = "";
  let businessId = "";
  let locationId = "";
  let employeeId = "";
  let serviceId = "";
  let customerId = "";
  let petId = "";

  let rivalCookie = "";
  let rivalAppointmentId = "";

  const key = () => crypto.randomUUID();
  // One booking per LOCAL DAY rather than per hour: a day apart cannot collide with
  // `employee_appointment_no_overlap`, and no booking can run into local midnight, which the
  // create route refuses outright.
  let bookingDay = 0;
  let sqlDay = 1;

  async function provision(sessionCookie: string, label: string) {
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: sessionCookie }, payload });
    const service = (await post("/api/services", {
      name: `${label} Groom`, baseDurationMinutes: 60, basePriceMinor: servicePriceMinor
    })).json().id as string;
    const employee = (await post("/api/employees", {
      displayName: `${label} Groomer`, serviceIds: [service]
    })).json().id as string;
    const customer = (await post("/api/customers", {
      firstName: label, lastName: "Client", phone: "555-0170"
    })).json().id as string;
    const pet = (await post("/api/pets", {
      customerId: customer, name: `${label} Pet`, species: "dog", breed: "Poodle"
    })).json().id as string;
    return { serviceId: service, employeeId: employee, customerId: customer, petId: pet };
  }

  /**
   * Seats a member holding EXACTLY one of the shipped role presets.
   *
   * The presets are imported rather than restated, so "which built-in roles may edit an
   * appointment" is answered by the catalogue itself. If Groomer ever gains `appointments.edit`,
   * the denial case below fails rather than quietly asserting something that stopped being true.
   */
  async function seat(label: string, permissions: readonly string[]): Promise<string> {
    const email = `notes-${label}-${suffix}@example.test`;
    const password = `correct horse ${label} battery`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash,display_name)
      values (${email},${email},${await hashPassword(password)},${label}) returning id
    `;
    await db`
      insert into business_memberships(business_id,user_id,role_id)
      values (${businessId},${user!.id},${await roleFor(db, businessId, permissions)})
    `;
    return cookie(await app.inject({
      method: "POST", url: "/api/auth/login", payload: { email, password }
    }));
  }

  /** A real booking through the create route, so the note under test is one the product wrote. */
  async function book(notes?: string | null, ids?: {
    locationId: string; customerId: string; petId: string; employeeId: string; serviceId: string;
  }, sessionCookie = ownerCookie) {
    const target = ids ?? { locationId, customerId, petId, employeeId, serviceId };
    bookingDay += 1;
    const response = await app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: sessionCookie, "idempotency-key": key() },
      payload: {
        locationId: target.locationId, customerId: target.customerId, petId: target.petId,
        employeeId: target.employeeId, serviceIds: [target.serviceId],
        localStart: `2034-08-${String(bookingDay).padStart(2, "0")}T09:00`,
        expectedLocationVersion: 1,
        ...(notes === undefined ? {} : { notes })
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; version: number };
  }

  /**
   * A completed visit carrying one service snapshot, seeded in SQL.
   *
   * The financial suites in this directory seed the same way, and for the same reason: the visit
   * under test is a settled one, and driving it through check-in and completion would be testing
   * the lifecycle rather than the thing this file is about.
   */
  async function completedAppointment(notes: string | null): Promise<string> {
    const start = `2034-09-${String(sqlDay).padStart(2, "0")}T16:00:00.000Z`;
    const end = `2034-09-${String(sqlDay).padStart(2, "0")}T17:00:00.000Z`;
    sqlDay += 1;
    const [appointment] = await db<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,notes,created_by,updated_by)
      select ${businessId},${locationId},${customerId},${petId},${employeeId},
        ${start}::timestamptz,${end}::timestamptz,'America/Los_Angeles',
        ${start}::timestamptz at time zone 'America/Los_Angeles',-420,'completed',${notes},user_id,user_id
      from business_memberships where business_id=${businessId} and is_owner returning id
    `;
    await db`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
        duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment!.id},${serviceId},'Notes Groom',60,${servicePriceMinor})
    `;
    return appointment!.id;
  }

  const editNote = (
    appointmentId: string,
    payload: Record<string, unknown>,
    sessionCookie = ownerCookie
  ) => app.inject({
    method: "PATCH", url: `/api/appointments/${appointmentId}`,
    headers: { cookie: sessionCookie }, payload
  });

  const detail = async (appointmentId: string, sessionCookie = ownerCookie) => {
    const response = await app.inject({
      method: "GET", url: `/api/appointments/${appointmentId}`, headers: { cookie: sessionCookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { id: string; notes: string | null; version: number };
  };

  const storedNote = async (appointmentId: string) => {
    const [row] = await db<{ notes: string | null; operationalNotes: string | null; version: number }[]>`
      select notes,operational_notes,version from appointments
      where business_id=${businessId} and id=${appointmentId}
    `;
    return row!;
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `notes-owner-${suffix}@example.test`,
        password: "correct horse notes battery", businessName: "Notes Salon"
      }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());
    // A real rate, so the immutability fingerprint below has a tax figure in it to protect.
    await db`update businesses set tax_rate_basis_points=${taxRateBasisPoints} where id=${businessId}`;

    ({ serviceId, employeeId, customerId, petId } = await provision(ownerCookie, "Notes"));

    managerCookie = await seat("manager", permissionPresets.manager!);
    receptionistCookie = await seat("receptionist", permissionPresets.receptionist!);
    groomerCookie = await seat("groomer", permissionPresets.groomer!);

    const rival = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `notes-rival-${suffix}@example.test`,
        password: "correct horse rival battery", businessName: "Rival Notes Salon"
      }
    });
    expect(rival.statusCode, rival.body).toBe(201);
    rivalCookie = cookie(rival);
    const rivalIds = await provision(rivalCookie, "Rival");
    rivalAppointmentId = (await book(null, { locationId: rival.json().locationId, ...rivalIds }, rivalCookie)).id;
  }, 60_000);

  afterAll(async () => { await app.close(); await db.end(); });

  describe("the field", () => {
    it("stores a note written at booking and hands it back on the detail read", async () => {
      const created = await book("Bring the ramp; Bnetley hates the steps");
      const row = await detail(created.id);
      expect(row.notes).toBe("Bring the ramp; Bnetley hates the steps");
      expect((await storedNote(created.id)).notes).toBe("Bring the ramp; Bnetley hates the steps");
    });

    it("edits the note after creation and returns the appointment in the detail shape", async () => {
      const created = await book("Bring the ramp; Bnetley hates the steps");
      const edited = await editNote(created.id, {
        notes: "Bring the ramp; Bentley hates the steps", version: created.version
      });
      expect(edited.statusCode, edited.body).toBe(200);
      const body = edited.json();
      expect(body.notes).toBe("Bring the ramp; Bentley hates the steps");
      expect(body.id).toBe(created.id);
      // The response is the same projection the detail read serves, so a screen that PATCHes
      // re-renders from one shape rather than merging two.
      expect(body).toEqual(await detail(created.id));
      expect(body.version).toBe(created.version + 1);
    });

    it("clears the note with null and with the empty string create accepts", async () => {
      const created = await book("Delete me");
      const cleared = await editNote(created.id, { notes: null });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().notes).toBeNull();
      expect((await storedNote(created.id)).notes).toBeNull();

      // `POST /api/appointments` stores `""` as `""` rather than folding it to null, so the edit
      // path does too: a value the booking route could write must be writable back.
      const blank = await book("");
      expect((await storedNote(blank.id)).notes).toBe("");
      const rewritten = await editNote(blank.id, { notes: "" });
      expect(rewritten.statusCode, rewritten.body).toBe(200);
      expect((await storedNote(blank.id)).notes).toBe("");
    });

    it("holds the same 5000-character ceiling create holds", async () => {
      const created = await book(null);
      const atCeiling = "x".repeat(5000);
      const accepted = await editNote(created.id, { notes: atCeiling });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect((await storedNote(created.id)).notes).toBe(atCeiling);

      const refused = await editNote(created.id, { notes: "x".repeat(5001) });
      expect(refused.statusCode).toBe(400);
      expect((await storedNote(created.id)).notes).toBe(atCeiling);
    });

    it("refuses a body that edits nothing and a body naming a field it does not own", async () => {
      const created = await book("Untouched");
      expect((await editNote(created.id, {})).statusCode).toBe(400);
      expect((await editNote(created.id, { version: 1 })).statusCode).toBe(400);
      // `operational_notes` is a different column with a different permission; naming it here is
      // a client mistake and must not be silently ignored.
      expect((await editNote(created.id, { operationalNotes: "Nails done" })).statusCode).toBe(400);
      expect((await storedNote(created.id)).notes).toBe("Untouched");
    });

    it("leaves operational_notes alone", async () => {
      const created = await book("Booking note");
      await db`
        update appointments set operational_notes='Half way through the tidy-up'
        where business_id=${businessId} and id=${created.id}
      `;
      const edited = await editNote(created.id, { notes: "Booking note, corrected" });
      expect(edited.statusCode, edited.body).toBe(200);
      const row = await storedNote(created.id);
      expect(row.notes).toBe("Booking note, corrected");
      expect(row.operationalNotes).toBe("Half way through the tidy-up");
    });
  });

  describe("who may edit it", () => {
    it("accepts the owner and every built-in role that holds appointments.edit", async () => {
      expect(permissionPresets.manager).toContain("appointments.edit");
      expect(permissionPresets.receptionist).toContain("appointments.edit");
      const created = await book("Original");

      for (const [label, session] of [
        ["owner", ownerCookie], ["manager", managerCookie], ["receptionist", receptionistCookie]
      ] as const) {
        const response = await editNote(created.id, { notes: `Written by the ${label}` }, session);
        expect(response.statusCode, `${label}: ${response.body}`).toBe(200);
        expect(response.json().notes).toBe(`Written by the ${label}`);
      }
    });

    it("refuses the built-in Groomer, who holds no appointment-edit authority", async () => {
      // Asserted against the catalogue, not against the role's name.
      expect(permissionPresets.groomer).not.toContain("appointments.edit");
      const created = await book("Groomer must not rewrite this");
      const refused = await editNote(created.id, { notes: "Rewritten" }, groomerCookie);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toContain("appointments.edit");
      expect((await storedNote(created.id)).notes).toBe("Groomer must not rewrite this");
    });

    it("refuses a member who may see appointments but not edit them", async () => {
      const viewer = await seat("viewer", ["calendar.view", "appointments.view"]);
      const created = await book("Read only");
      const refused = await editNote(created.id, { notes: "Rewritten" }, viewer);
      expect(refused.statusCode, refused.body).toBe(403);
      expect((await storedNote(created.id)).notes).toBe("Read only");
    });
  });

  describe("tenancy and concurrency", () => {
    it("is invisible across businesses in both directions", async () => {
      const mine = await book("Ours");
      const theirs = await editNote(mine.id, { notes: "Theirs now" }, rivalCookie);
      expect(theirs.statusCode).toBe(404);
      expect((await storedNote(mine.id)).notes).toBe("Ours");

      const reverse = await editNote(rivalAppointmentId, { notes: "Ours now" }, ownerCookie);
      expect(reverse.statusCode).toBe(404);
      const [rivalRow] = await db<{ notes: string | null }[]>`
        select notes from appointments where id=${rivalAppointmentId}
      `;
      expect(rivalRow!.notes).toBeNull();
    });

    it("refuses a stale version with 409 and writes nothing", async () => {
      const created = await book("First");
      const first = await editNote(created.id, { notes: "Second", version: created.version });
      expect(first.statusCode, first.body).toBe(200);

      const stale = await editNote(created.id, { notes: "Third", version: created.version });
      expect(stale.statusCode, stale.body).toBe(409);
      const row = await storedNote(created.id);
      expect(row.notes).toBe("Second");
      expect(row.version).toBe(created.version + 1);

      // The version the 200 handed back is the one that works next.
      const retried = await editNote(created.id, { notes: "Third", version: first.json().version });
      expect(retried.statusCode, retried.body).toBe(200);
      expect((await storedNote(created.id)).notes).toBe("Third");
    });

    it("answers 404 for an appointment that does not exist", async () => {
      expect((await editNote(crypto.randomUUID(), { notes: "Nowhere" })).statusCode).toBe(404);
    });
  });

  describe("the audit trail", () => {
    it("appends a field-level edit event and emits no outbox event", async () => {
      const created = await book("Before");
      const outboxBefore = await db<{ count: number }[]>`
        select count(*)::int as count from outbox_events
        where business_id=${businessId} and resource_id=${created.id}
      `;
      const edited = await editNote(created.id, {
        notes: "After", version: created.version, reason: "Client called to correct the spelling"
      });
      expect(edited.statusCode, edited.body).toBe(200);

      const [event] = await db<{
        beforeData: { notes: string | null }; afterData: { notes: string | null }; reason: string | null;
      }[]>`
        select before_data,after_data,reason from audit_events
        where business_id=${businessId} and resource_id=${created.id} and action='appointment.notes_edit'
        order by created_at desc limit 1
      `;
      expect(event).toBeDefined();
      expect(event!.beforeData.notes).toBe("Before");
      expect(event!.afterData.notes).toBe("After");
      expect(event!.reason).toBe("Client called to correct the spelling");

      // `AppointmentUpdated` re-arms the reminder intent, including one a cancellation stood down.
      // A note edit is not a change to the visit the customer was told about, so it emits nothing.
      const outboxAfter = await db<{ count: number }[]>`
        select count(*)::int as count from outbox_events
        where business_id=${businessId} and resource_id=${created.id}
      `;
      expect(outboxAfter[0]!.count).toBe(outboxBefore[0]!.count);
    });
  });

  describe("after the money", () => {
    /**
     * Everything about this invoice that a client, an accountant or a dispute could care about.
     *
     * Whole rows rather than a hand-picked list of columns, so a field added to any of these
     * tables is protected the day it is added rather than the day somebody remembers to extend
     * this helper. `updated_at` is inside the fingerprint too: a write that changed nothing but
     * still touched the row is a write this route must not be making.
     */
    async function financialFingerprint(appointmentId: string, invoiceId: string) {
      const [snapshots, invoice, items, discounts, payments, credits, receipt] = await Promise.all([
        db`select * from appointment_services
           where business_id=${businessId} and appointment_id=${appointmentId} order by id`,
        db`select * from invoices where business_id=${businessId} and id=${invoiceId}`,
        db`select * from invoice_items
           where business_id=${businessId} and invoice_id=${invoiceId} order by line_position,id`,
        db`select * from invoice_discounts
           where business_id=${businessId} and invoice_id=${invoiceId} order by line_position,id`,
        db`select * from payments
           where business_id=${businessId} and invoice_id=${invoiceId} order by recorded_at,id`,
        db`select * from customer_credit_entries
           where business_id=${businessId} and customer_id=${customerId} order by created_at,id`,
        app.inject({
          method: "GET", url: `/api/invoices/${invoiceId}/receipt`, headers: { cookie: ownerCookie }
        }).then((response) => {
          expect(response.statusCode, response.body).toBe(200);
          return response.json();
        })
      ]);
      // Serialised, so timestamps compare as values rather than as Date identities.
      return JSON.parse(JSON.stringify({
        snapshots, invoice, items, discounts, payments, credits, receipt
      }));
    }

    /** A completed visit taken all the way through discount, tax, tip, credit and cash. */
    async function settledVisit(note: string | null) {
      const appointmentId = await completedAppointment(note);
      const granted = await app.inject({
        method: "POST", url: `/api/customers/${customerId}/credit`,
        headers: { cookie: ownerCookie, "idempotency-key": key() },
        payload: { kind: "grant", amountMinor: 2_000, reason: "Goodwill after a late finish" }
      });
      expect(granted.statusCode, granted.body).toBe(201);

      const checkout = await app.inject({
        method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
        headers: { cookie: ownerCookie, "idempotency-key": key() },
        payload: {
          discountMinor: 500, discountType: "Loyalty", tipMinor: 1_000, appliedDiscountIds: []
        }
      });
      expect(checkout.statusCode, checkout.body).toBe(201);
      const invoice = checkout.json() as {
        id: string; subtotalMinor: number; discountMinor: number; taxMinor: number;
        tipMinor: number; totalMinor: number; balanceMinor: number;
      };
      expect(invoice.subtotalMinor).toBe(servicePriceMinor);
      expect(invoice.discountMinor).toBe(500);
      expect(invoice.taxMinor).toBeGreaterThan(0);
      expect(invoice.tipMinor).toBe(1_000);

      const credit = await app.inject({
        method: "POST", url: `/api/invoices/${invoice.id}/payments`,
        headers: { cookie: ownerCookie, "idempotency-key": key() },
        payload: {
          amountMinor: 2_000, expectedBalanceMinor: invoice.balanceMinor, method: "client_credit"
        }
      });
      expect(credit.statusCode, credit.body).toBe(201);
      const remaining = credit.json().balance as number;
      expect(remaining).toBe(invoice.balanceMinor - 2_000);

      const cash = await app.inject({
        method: "POST", url: `/api/invoices/${invoice.id}/payments`,
        headers: { cookie: ownerCookie, "idempotency-key": key() },
        payload: { amountMinor: remaining, expectedBalanceMinor: remaining, method: "cash" }
      });
      expect(cash.statusCode, cash.body).toBe(201);
      expect(cash.json().balance).toBe(0);
      return { appointmentId, invoiceId: invoice.id };
    }

    it("edits the note on a completed visit", async () => {
      const appointmentId = await completedAppointment("Finished, coat was matted");
      const edited = await editNote(appointmentId, { notes: "Finished; coat was matted" });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json().status).toBe("completed");
      expect((await storedNote(appointmentId)).notes).toBe("Finished; coat was matted");
    });

    it("edits the note once an invoice exists", async () => {
      const appointmentId = await completedAppointment("Invoiced with a typo");
      const checkout = await app.inject({
        method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
        headers: { cookie: ownerCookie, "idempotency-key": key() },
        payload: { discountMinor: 0, discountType: null, tipMinor: 0, appliedDiscountIds: [] }
      });
      expect(checkout.statusCode, checkout.body).toBe(201);
      const edited = await editNote(appointmentId, { notes: "Invoiced, typo corrected" });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json().invoiceId).toBe(checkout.json().id);
      expect((await storedNote(appointmentId)).notes).toBe("Invoiced, typo corrected");
    });

    it("edits the note once the invoice is paid", async () => {
      const { appointmentId, invoiceId } = await settledVisit("Paid, name misspelled");
      const edited = await editNote(appointmentId, { notes: "Paid, name corrected" });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json().invoiceBalanceMinor).toBe(0);
      expect((await storedNote(appointmentId)).notes).toBe("Paid, name corrected");
      const [invoice] = await db<{ status: string; balanceMinor: number }[]>`
        select status,balance_minor from invoices where business_id=${businessId} and id=${invoiceId}
      `;
      expect(invoice).toMatchObject({ status: "paid", balanceMinor: 0 });
    });

    /**
     * THE INVARIANT: editable appointment metadata is not mutable financial history.
     *
     * One discounted, taxed, tipped invoice, settled from client credit and cash, fingerprinted
     * whole - snapshots, invoice, line items, discount breakdown, payments, the client's credit
     * ledger and the rendered receipt - then a note edit, then the same fingerprint. Nothing about
     * the money is allowed to have moved, been recomputed, or been reissued.
     */
    it("changes not one financial value when the note is edited on a paid, invoiced visit", async () => {
      const { appointmentId, invoiceId } = await settledVisit("Bnetley, standard groom");
      const before = await financialFingerprint(appointmentId, invoiceId);
      // The fingerprint has to have something in it, or "unchanged" is worth nothing. Every
      // financial shape this route must not disturb is present before the edit is made.
      expect(before.snapshots).toHaveLength(1);
      expect(before.invoice[0].taxMinor).toBeGreaterThan(0);
      expect(before.invoice[0].discountMinor).toBe(500);
      expect(before.invoice[0].tipMinor).toBe(1_000);
      expect(before.items).toHaveLength(1);
      expect(before.discounts.length).toBeGreaterThan(0);
      expect(before.payments).toHaveLength(2);
      // A grant and the redemption that spent it.
      expect(before.credits.length).toBeGreaterThanOrEqual(2);
      expect(before.receipt.invoice.totalMinor).toBe(before.invoice[0].totalMinor);

      const edited = await editNote(appointmentId, {
        notes: "Bentley, standard groom", reason: "Corrected the dog's name"
      });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json().notes).toBe("Bentley, standard groom");

      const after = await financialFingerprint(appointmentId, invoiceId);
      expect(after).toEqual(before);

      // Stated field by field as well, so a failure names the number that moved rather than
      // pointing at one enormous object diff.
      expect(after.invoice[0]).toMatchObject({
        subtotalMinor: before.invoice[0].subtotalMinor,
        discountMinor: before.invoice[0].discountMinor,
        taxMinor: before.invoice[0].taxMinor,
        tipMinor: before.invoice[0].tipMinor,
        totalMinor: before.invoice[0].totalMinor,
        balanceMinor: before.invoice[0].balanceMinor,
        status: before.invoice[0].status,
        updatedAt: before.invoice[0].updatedAt
      });
      expect(after.snapshots.map((row: { priceMinorSnapshot: number }) => row.priceMinorSnapshot))
        .toEqual(before.snapshots.map((row: { priceMinorSnapshot: number }) => row.priceMinorSnapshot));
      expect(after.payments).toHaveLength(2);
      expect(after.credits.map((row: { kind: string; amountMinor: number }) =>
        [row.kind, row.amountMinor])).toEqual(
          before.credits.map((row: { kind: string; amountMinor: number }) => [row.kind, row.amountMinor]));
      expect(after.receipt.refundedMinor).toBe(before.receipt.refundedMinor);

      // And no second invoice was issued for the visit, which is the other way a "reissue" would
      // show up.
      const [invoiceCount] = await db<{ count: number }[]>`
        select count(*)::int as count from invoices
        where business_id=${businessId} and appointment_id=${appointmentId}
      `;
      expect(invoiceCount!.count).toBe(1);
    });
  });
});
