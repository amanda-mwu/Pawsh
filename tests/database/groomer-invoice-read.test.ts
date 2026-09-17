import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoiceSettledStatuses, permissionPresets } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { roleFor } from "../support/roles.js";

/**
 * FOR PAID APPOINTMENTS, GROOMERS CAN VIEW INVOICES.
 *
 * `GET /api/invoices/:id/receipt` is the one invoice read - the appointment surface's Invoice
 * control and the Invoice workspace both open it - and it was gated on `payments.view` alone.
 * It now also answers a caller WITHOUT `payments.view` when both hold: the invoice's appointment
 * is assigned to the caller's own employee record, resolved from `employees.membership_id` and
 * the session exactly as every appointment write resolves it, AND the invoice is settled -
 * `invoiceSettledStatuses`, which is what the domain already means by "paid".
 *
 * The file states that rule from the outside, through real sessions and real routes:
 *
 *   - a groomer reads the receipt of their own paid appointment, and gets the same document a
 *     `payments.view` holder gets, byte for byte;
 *   - the same groomer is refused a colleague's paid receipt, and their own receipt while it is
 *     still owing - open, or partly paid;
 *   - a member on the groomer preset with no employee record owns nothing and is refused;
 *   - nothing else widened: the tender, void, refund and client-history routes refuse the same
 *     groomer on their own paid invoice exactly as before;
 *   - a receipt in another business is a 404 for everybody, before whose appointment it is
 *     comes into it;
 *   - `payments.view` still reads any bill in the business, owing or settled, assigned or not.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "groomer-invoice-read-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

interface Invoice { id: string; balanceMinor: number; status: string }

describeDatabase("groomer invoice read", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();

  let ownerCookie = "";
  let businessId = "";
  let locationId = "";
  let serviceId = "";
  let customerId = "";
  let petId = "";

  let employeeA = "";
  let employeeB = "";
  let groomerA = "";
  let groomerB = "";
  /** The Groomer preset, and NO employee record. */
  let unlinkedGroomer = "";
  /** `payments.view` and nothing operational: the reader the receipt has always answered. */
  let bookkeeper = "";

  let rivalCookie = "";
  let rivalInvoiceId = "";

  const key = () => crypto.randomUUID();
  // One booking per LOCAL DAY per groomer, so no two bookings can collide on
  // `employee_appointment_no_overlap`.
  let bookingDay = 0;
  const nextDay = () => {
    bookingDay += 1;
    return `2036-03-${String(bookingDay).padStart(2, "0")}`;
  };

  const request = (method: "GET" | "POST" | "PATCH", url: string, sessionCookie: string,
    payload?: Record<string, unknown>) =>
    app.inject({
      method, url, headers: { cookie: sessionCookie, "idempotency-key": key() },
      ...(payload ? { payload } : {})
    });

  /** Seats a member holding exactly `permissions`, and returns its cookie and membership id. */
  async function seat(label: string, permissions: readonly string[]) {
    const email = `invoice-read-${label}-${suffix}@example.test`;
    const password = `correct horse ${label} battery`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash,display_name)
      values (${email},${email},${await hashPassword(password)},${label}) returning id
    `;
    const [membership] = await db<{ id: string }[]>`
      insert into business_memberships(business_id,user_id,role_id)
      values (${businessId},${user!.id},${await roleFor(db, businessId, permissions)})
      returning id
    `;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    expect(login.statusCode, login.body).toBe(200);
    return { cookie: cookie(login), membershipId: membership!.id };
  }

  /** A groomer the owner creates through the real route, linked to the given membership. */
  async function employeeFor(displayName: string, membershipId: string): Promise<string> {
    const response = await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName, serviceIds: [serviceId], membershipId }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  /** A real booking for one groomer, checked in by the owner so it can be billed. */
  async function checkedIn(employeeId: string): Promise<string> {
    const booked = await request("POST", "/api/appointments", ownerCookie, {
      locationId, customerId, petId, employeeId, serviceIds: [serviceId],
      localStart: `${nextDay()}T09:00`, expectedLocationVersion: 1
    });
    expect(booked.statusCode, booked.body).toBe(201);
    const id = booked.json().id as string;
    const arrived = await request("POST", `/api/appointments/${id}/transition`, ownerCookie, { status: "checked_in" });
    expect(arrived.statusCode, arrived.body).toBe(200);
    return id;
  }

  /** The owner bills a visit. The invoice is `open` until something is paid against it. */
  async function invoiced(employeeId: string): Promise<Invoice & { appointmentId: string }> {
    const appointmentId = await checkedIn(employeeId);
    const created = await request("POST", `/api/appointments/${appointmentId}/checkout`, ownerCookie,
      { discountMinor: 0, discountType: null, tipMinor: 0 });
    expect(created.statusCode, created.body).toBe(201);
    return { ...(created.json() as Invoice), appointmentId };
  }

  const pay = (invoice: Invoice, amountMinor: number, sessionCookie = ownerCookie) =>
    request("POST", `/api/invoices/${invoice.id}/payments`, sessionCookie,
      { amountMinor, expectedBalanceMinor: invoice.balanceMinor, method: "cash", externalReference: null });

  /** A visit for `employeeId`, billed and paid in full by the owner. */
  async function paid(employeeId: string): Promise<Invoice & { appointmentId: string }> {
    const invoice = await invoiced(employeeId);
    const settled = await pay(invoice, invoice.balanceMinor);
    expect(settled.statusCode, settled.body).toBe(201);
    const [row] = await db<{ status: string }[]>`
      select status from invoices where business_id=${businessId} and id=${invoice.id}
    `;
    expect(row!.status).toBe("paid");
    return { ...invoice, status: "paid", balanceMinor: 0 };
  }

  const receipt = (invoiceId: string, sessionCookie: string) =>
    app.inject({ method: "GET", url: `/api/invoices/${invoiceId}/receipt`, headers: { cookie: sessionCookie } });

  const expectPaymentsViewRefusal = (response: { statusCode: number; body: string; json: () => unknown }, label: string) => {
    expect(response.statusCode, `${label}: ${response.body}`).toBe(403);
    expect((response.json() as { error: string }).error, label).toBe("Missing permission: payments.view");
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `invoice-read-owner-${suffix}@example.test`,
        password: "correct horse invoice battery", businessName: "Invoice Read Salon"
      }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());

    const service = await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name: "Invoice Groom", baseDurationMinutes: 60, basePriceMinor: 7000 }
    });
    expect(service.statusCode, service.body).toBe(201);
    serviceId = service.json().id;

    const customer = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName: "Invoice", lastName: "Client", phone: "555-0190" }
    });
    expect(customer.statusCode, customer.body).toBe(201);
    customerId = customer.json().id;
    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Invoice Pet", species: "dog", breed: "Poodle" }
    });
    expect(pet.statusCode, pet.body).toBe(201);
    petId = pet.json().id;

    // Two groomers, each a member on the Groomer preset AND an employee linked to that
    // membership. The preset holds neither `payments.view` nor `checkout.perform`.
    expect(permissionPresets.groomer).not.toContain("payments.view");
    expect(permissionPresets.groomer).not.toContain("checkout.perform");
    const groomerSeatA = await seat("groomer-a", permissionPresets.groomer!);
    const groomerSeatB = await seat("groomer-b", permissionPresets.groomer!);
    groomerA = groomerSeatA.cookie;
    groomerB = groomerSeatB.cookie;
    employeeA = await employeeFor("Groomer A", groomerSeatA.membershipId);
    employeeB = await employeeFor("Groomer B", groomerSeatB.membershipId);

    unlinkedGroomer = (await seat("unlinked", permissionPresets.groomer!)).cookie;
    bookkeeper = (await seat("bookkeeper", ["payments.view"])).cookie;

    // Another salon, with a paid invoice of its own.
    const rival = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `invoice-read-rival-${suffix}@example.test`,
        password: "correct horse rival battery", businessName: "Rival Invoice Salon"
      }
    });
    expect(rival.statusCode, rival.body).toBe(201);
    rivalCookie = cookie(rival);
    const rivalPost = (url: string, payload: Record<string, unknown>) =>
      request("POST", url, rivalCookie, payload);
    const rivalService = (await rivalPost("/api/services", {
      name: "Rival Groom", baseDurationMinutes: 60, basePriceMinor: 7000
    })).json().id;
    const rivalEmployee = (await rivalPost("/api/employees", {
      displayName: "Rival Groomer", serviceIds: [rivalService]
    })).json().id;
    const rivalCustomer = (await rivalPost("/api/customers", {
      firstName: "Rival", lastName: "Client", phone: "555-0191"
    })).json().id;
    const rivalPet = (await rivalPost("/api/pets", {
      customerId: rivalCustomer, name: "Rival Pet", species: "dog", breed: "Poodle"
    })).json().id;
    const rivalBooking = await rivalPost("/api/appointments", {
      locationId: rival.json().locationId, customerId: rivalCustomer, petId: rivalPet,
      employeeId: rivalEmployee, serviceIds: [rivalService],
      localStart: "2036-03-01T09:00", expectedLocationVersion: 1
    });
    expect(rivalBooking.statusCode, rivalBooking.body).toBe(201);
    const rivalArrived = await rivalPost(`/api/appointments/${rivalBooking.json().id}/transition`, { status: "checked_in" });
    expect(rivalArrived.statusCode, rivalArrived.body).toBe(200);
    const rivalInvoice = await rivalPost(`/api/appointments/${rivalBooking.json().id}/checkout`,
      { discountMinor: 0, discountType: null, tipMinor: 0 });
    expect(rivalInvoice.statusCode, rivalInvoice.body).toBe(201);
    rivalInvoiceId = rivalInvoice.json().id;
    const rivalPaid = await pay(rivalInvoice.json() as Invoice, (rivalInvoice.json() as Invoice).balanceMinor, rivalCookie);
    expect(rivalPaid.statusCode, rivalPaid.body).toBe(201);
  }, 90_000);

  afterAll(async () => { await app.close(); await db.end(); });

  it("pins what 'paid' means: the domain's settled statuses, and nothing still owing", () => {
    expect([...invoiceSettledStatuses].sort()).toEqual(["paid", "partially_refunded", "refunded"]);
    expect(invoiceSettledStatuses).not.toContain("open");
    expect(invoiceSettledStatuses).not.toContain("partially_paid");
    expect(invoiceSettledStatuses).not.toContain("void");
  });

  describe("a groomer and their own paid invoice", () => {
    it("reads it, and gets exactly the document a payments.view holder gets", async () => {
      const invoice = await paid(employeeA);
      const mine = await receipt(invoice.id, groomerA);
      expect(mine.statusCode, mine.body).toBe(200);
      const viewer = await receipt(invoice.id, bookkeeper);
      expect(viewer.statusCode, viewer.body).toBe(200);
      expect(mine.json()).toEqual(viewer.json());
      const document = mine.json() as {
        invoice: { id: string; status: string; appointmentId: string };
        items: unknown[]; payments: unknown[]; refunds: unknown[]; refundedMinor: number; discounts: unknown[];
      };
      expect(document.invoice.id).toBe(invoice.id);
      expect(document.invoice.status).toBe("paid");
      expect(document.invoice.appointmentId).toBe(invoice.appointmentId);
      expect(document.items).toHaveLength(1);
      expect(document.payments).toHaveLength(1);
      expect(document.refunds).toEqual([]);
      expect(document.refundedMinor).toBe(0);
      expect(document.discounts).toEqual([]);
    });

    it("is refused a colleague's paid invoice", async () => {
      const theirs = await paid(employeeB);
      expectPaymentsViewRefusal(await receipt(theirs.id, groomerA), "groomer A on groomer B's paid invoice");
      // And the colleague, whose appointment it is, reads it.
      const own = await receipt(theirs.id, groomerB);
      expect(own.statusCode, own.body).toBe(200);
    });

    it("is refused their own invoice while it is still owing", async () => {
      const open = await invoiced(employeeA);
      expect(open.status).toBe("open");
      expectPaymentsViewRefusal(await receipt(open.id, groomerA), "groomer A on own open invoice");

      const partly = await pay(open, 1000);
      expect(partly.statusCode, partly.body).toBe(201);
      const [row] = await db<{ status: string }[]>`
        select status from invoices where business_id=${businessId} and id=${open.id}
      `;
      expect(row!.status).toBe("partially_paid");
      expectPaymentsViewRefusal(await receipt(open.id, groomerA), "groomer A on own partly paid invoice");

      // The bookkeeper reads an owing bill exactly as before.
      expect((await receipt(open.id, bookkeeper)).statusCode).toBe(200);
    });

    it("gains nothing but the read: tender, void, refund and client history all still refuse", async () => {
      const invoice = await paid(employeeA);
      const document = (await receipt(invoice.id, groomerA)).json() as { payments: { id: string }[] };
      const paymentId = document.payments[0]!.id;

      const tender = await pay({ ...invoice, balanceMinor: 0 }, 100, groomerA);
      expect(tender.statusCode, tender.body).toBe(403);
      expect(tender.json().error).toBe("Missing permission: checkout.perform");

      const voided = await request("POST", `/api/payments/${paymentId}/void`, groomerA, { reason: "wrong" });
      expect(voided.statusCode, voided.body).toBe(403);

      const refundState = await request("GET", `/api/payments/${paymentId}/refunds`, groomerA);
      expect(refundState.statusCode, refundState.body).toBe(403);
      const refund = await request("POST", `/api/payments/${paymentId}/refunds`, groomerA,
        { amountMinor: 100, expectedRefundableMinor: 7000, reason: "no" });
      expect(refund.statusCode, refund.body).toBe(403);

      const history = await request("GET", `/api/customers/${customerId}/history`, groomerA);
      expect(history.statusCode, history.body).toBe(403);

      // The payment is untouched by any of that.
      const [payment] = await db<{ status: string }[]>`
        select status from payments where business_id=${businessId} and id=${paymentId}
      `;
      expect(payment!.status).toBe("recorded");
    });
  });

  describe("who cannot read", () => {
    it("refuses a member on the groomer preset with no employee record", async () => {
      const invoice = await paid(employeeA);
      expectPaymentsViewRefusal(await receipt(invoice.id, unlinkedGroomer), "unlinked groomer");
    });

    it("answers 404 across a tenant boundary, for a groomer and for a payments.view holder alike", async () => {
      expect((await receipt(rivalInvoiceId, groomerA)).statusCode).toBe(404);
      expect((await receipt(rivalInvoiceId, bookkeeper)).statusCode).toBe(404);
      expect((await receipt(rivalInvoiceId, ownerCookie)).statusCode).toBe(404);
      // The rival's own owner still reads it, so the 404 is the boundary and not the invoice.
      expect((await receipt(rivalInvoiceId, rivalCookie)).statusCode).toBe(200);
      // And this salon's paid invoice is a 404 to the rival.
      const invoice = await paid(employeeA);
      expect((await receipt(invoice.id, rivalCookie)).statusCode).toBe(404);
    });
  });

  describe("payments.view is unchanged", () => {
    it("reads any bill in the business, assigned to nobody the caller is", async () => {
      const mine = await paid(employeeA);
      const theirs = await invoiced(employeeB);
      for (const invoice of [mine, theirs]) {
        expect((await receipt(invoice.id, bookkeeper)).statusCode).toBe(200);
        expect((await receipt(invoice.id, ownerCookie)).statusCode).toBe(200);
      }
    });
  });
});
