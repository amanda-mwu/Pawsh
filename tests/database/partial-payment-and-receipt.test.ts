import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoiceOutstandingStatuses } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * CAN AN OPERATOR TAKE PART OF THE MONEY? This file exists to answer that with a test rather
 * than with a reading of the code.
 *
 * `POST /api/invoices/:id/payments` has always accepted an arbitrary positive `amountMinor`, and
 * the only thing that has ever forced a full settlement is a single line of client code sending
 * the whole balance. `checkout-regression.test.ts` proves that two CONCURRENT partial payments
 * serialize correctly and that a STALE overpayment is a 409 - but not the two plainest cases a
 * Pay control depends on: that a smaller amount leaves a collectable balance under a
 * `partially_paid` status, and that a larger one is refused with
 * `PAYMENT_EXCEEDS_CURRENT_BALANCE` rather than a 409 about concurrency. Those are here.
 *
 * The receipt's salon identity is in the same file because it needs the same invoice, and
 * because a Ticket header and a Pay control are two halves of one screen.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "partial-payment-receipt-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("partial payment and the receipt's salon identity", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  let ownerCookie = "";
  let businessId = "";
  let locationId = "";
  let employeeId = "";
  let serviceId = "";
  let customerId = "";
  let petId = "";
  let day = 1;

  const key = () => crypto.randomUUID();

  /** A completed appointment carrying one 10000-minor service snapshot. */
  async function completedAppointment(): Promise<string> {
    const start = `2034-07-${String(day).padStart(2, "0")}T16:00:00.000Z`;
    const end = `2034-07-${String(day).padStart(2, "0")}T17:00:00.000Z`;
    const local = `2034-07-${String(day).padStart(2, "0")}T09:00:00`;
    day += 1;
    const [appointment] = await db<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      select ${businessId},${locationId},${customerId},${petId},${employeeId},
        ${start}::timestamptz,${end}::timestamptz,'America/Los_Angeles',${local},-420,'completed',user_id,user_id
      from business_memberships where business_id=${businessId} and is_owner returning id
    `;
    await db`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
        duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment!.id},${serviceId},'Payment Groom',60,10000)
    `;
    return appointment!.id;
  }

  const checkout = (appointmentId: string, tipMinor = 0) =>
    app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
      headers: { cookie: ownerCookie, "idempotency-key": key() },
      payload: { discountMinor: 0, discountType: null, tipMinor }
    });

  const pay = (invoiceId: string, amountMinor: number, expectedBalanceMinor: number) =>
    app.inject({
      method: "POST", url: `/api/invoices/${invoiceId}/payments`,
      headers: { cookie: ownerCookie, "idempotency-key": key() },
      payload: { amountMinor, expectedBalanceMinor, method: "cash", externalReference: null }
    });

  const receipt = (invoiceId: string) =>
    app.inject({ method: "GET", url: `/api/invoices/${invoiceId}/receipt`, headers: { cookie: ownerCookie } });

  /** A fresh invoice with a known balance, so each case starts from a clean position. */
  async function openInvoice(tipMinor = 0) {
    const created = await checkout(await completedAppointment(), tipMinor);
    expect(created.statusCode, created.body).toBe(201);
    return created.json() as { id: string; totalMinor: number; balanceMinor: number; status: string };
  }

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const ownerEmail = `pay-owner-${suffix}@example.test`;
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: ownerEmail, password: "correct horse payment battery", businessName: "Payment Salon" }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());

    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
    serviceId = (await post("/api/services", {
      name: "Payment Groom", baseDurationMinutes: 60, basePriceMinor: 10000
    })).json().id;
    employeeId = (await post("/api/employees", {
      displayName: "Payment Groomer", serviceIds: [serviceId]
    })).json().id;
    customerId = (await post("/api/customers", {
      firstName: "Payment", lastName: "Client", phone: "555-0155"
    })).json().id;
    petId = (await post("/api/pets", {
      customerId, name: "Payment Pet", species: "dog", breed: "Poodle"
    })).json().id;
  }, 30_000);

  afterAll(async () => { await app.close(); await db.end(); });

  it("takes less than the balance and leaves the rest collectable", async () => {
    const invoice = await openInvoice();
    expect(invoice.status).toBe("open");
    const part = Math.floor(invoice.balanceMinor / 3);
    expect(part).toBeGreaterThan(0);

    const first = await pay(invoice.id, part, invoice.balanceMinor);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().balance).toBe(invoice.balanceMinor - part);

    const afterPart = (await receipt(invoice.id)).json();
    expect(afterPart.invoice.balanceMinor).toBe(invoice.balanceMinor - part);
    // The status a Pay control has to be able to leave behind. It is an OUTSTANDING status - the
    // bill is still collectable and still reachable through the `invoice_outstanding` index.
    expect(afterPart.invoice.status).toBe("partially_paid");
    expect(invoiceOutstandingStatuses).toContain("partially_paid");
    expect(afterPart.payments).toHaveLength(1);
    expect(afterPart.payments[0]).toMatchObject({ amountMinor: part, status: "recorded", method: "cash" });

    // A second partial closes it, so the invoice is settled by two smaller amounts and never by
    // one full one. `paid`, not `partially_paid`, is what the last payment must leave.
    const remainder = afterPart.invoice.balanceMinor;
    const second = await pay(invoice.id, remainder, remainder);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().balance).toBe(0);
    const settled = (await receipt(invoice.id)).json();
    expect(settled.invoice).toMatchObject({ status: "paid", balanceMinor: 0 });
    expect(settled.payments.map((payment: { amountMinor: number }) => payment.amountMinor))
      .toEqual([part, remainder]);
  });

  it("refuses more than the balance with PAYMENT_EXCEEDS_CURRENT_BALANCE and writes nothing", async () => {
    const invoice = await openInvoice();
    // `expectedBalanceMinor` MATCHES, so nothing about this is a concurrency problem: the
    // operator is looking at the current balance and asking for more than it. The 400 and the
    // code are what distinguish "you asked for too much" from "somebody moved the balance".
    const over = await pay(invoice.id, invoice.balanceMinor + 500, invoice.balanceMinor);
    expect(over.statusCode).toBe(400);
    expect(over.json().code).toBe("PAYMENT_EXCEEDS_CURRENT_BALANCE");

    // One minor unit over is still over. The boundary is where an over-tender control would land.
    const byOne = await pay(invoice.id, invoice.balanceMinor + 1, invoice.balanceMinor);
    expect(byOne.statusCode).toBe(400);
    expect(byOne.json().code).toBe("PAYMENT_EXCEEDS_CURRENT_BALANCE");

    // The refusals left no payment row and no status change behind.
    const unchanged = (await receipt(invoice.id)).json();
    expect(unchanged.payments).toEqual([]);
    expect(unchanged.invoice).toMatchObject({ status: "open", balanceMinor: invoice.balanceMinor });

    // And the exact balance is accepted, so the boundary above is a ceiling rather than a wall.
    const exact = await pay(invoice.id, invoice.balanceMinor, invoice.balanceMinor);
    expect(exact.statusCode, exact.body).toBe(201);
    expect((await receipt(invoice.id)).json().invoice).toMatchObject({ status: "paid", balanceMinor: 0 });
  });

  it("separates an overpayment from a stale balance, and refuses payment once settled", async () => {
    const invoice = await openInvoice();
    const part = Math.floor(invoice.balanceMinor / 2);
    expect((await pay(invoice.id, part, invoice.balanceMinor)).statusCode).toBe(201);

    // Same request, replayed against a balance that has since moved. Over the CURRENT balance and
    // wrong about what that balance is: 409, because the honest sentence is "the balance changed",
    // not "you asked for too much".
    const stale = await pay(invoice.id, invoice.balanceMinor, invoice.balanceMinor);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("STALE_FINANCIAL_STATE");

    const remainder = invoice.balanceMinor - part;
    expect((await pay(invoice.id, remainder, remainder)).statusCode).toBe(201);
    // A settled invoice is not payable at all, which is a status check rather than a balance one.
    const closed = await pay(invoice.id, 100, 0);
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe("STALE_FINANCIAL_STATE");
  });

  it("accepts an over-tender only as a tip folded in before the invoice exists", async () => {
    // THE ANSWER TO "apply remainder to tip". The tip is part of `total_minor` from the moment the
    // invoice is created, so a customer handing over more than the services cost is charged the
    // larger amount legitimately and the payment settles it exactly. There is no post-invoice
    // path: `claimTerminalCheckout` refuses an invoice whose `tip_minor` is already non-zero, and
    // Terminal reconciliation raises the tip once under a `where tip_minor = 0` fence, so a
    // later raise would either block Terminal for that invoice or collide with that fence.
    const withoutTip = await openInvoice(0);
    const withTip = await openInvoice(1500);
    expect(withTip.totalMinor).toBe(withoutTip.totalMinor + 1500);
    expect(withTip.balanceMinor).toBe(withoutTip.balanceMinor + 1500);

    const settled = await pay(withTip.id, withTip.balanceMinor, withTip.balanceMinor);
    expect(settled.statusCode, settled.body).toBe(201);
    const paid = (await receipt(withTip.id)).json();
    expect(paid.invoice).toMatchObject({ status: "paid", balanceMinor: 0, tipMinor: 1500 });

    // Whereas the same over-tender asked for after the fact is simply refused, which is why the
    // remainder has to be decided before checkout rather than at the Pay control.
    const afterTheFact = await pay(withoutTip.id, withoutTip.balanceMinor + 1500, withoutTip.balanceMinor);
    expect(afterTheFact.statusCode).toBe(400);
    expect(afterTheFact.json().code).toBe("PAYMENT_EXCEEDS_CURRENT_BALANCE");
  });

  it("carries the salon's name, phone and email on the receipt", async () => {
    // Written through Settings -> Business, which is the only writer of these two columns and
    // therefore the only thing that makes them safe to render.
    const [current] = await db<{
      currency: string; taxRateBasisPoints: number; reminderLeadMinutes: number; locationVersion: number;
    }[]>`
      select b.currency,b.tax_rate_basis_points,b.reminder_lead_minutes,l.version as location_version
      from businesses b join locations l on l.business_id=b.id and l.active
      where b.id=${businessId}
    `;
    const saved = await app.inject({
      method: "PUT", url: "/api/business/settings", headers: { cookie: ownerCookie },
      payload: {
        name: "Payment Salon", phone: "555-0199", email: "front-desk@payment.test",
        timezone: "America/Los_Angeles", currency: current!.currency,
        taxRateBasisPoints: Number(current!.taxRateBasisPoints),
        reminderLeadMinutes: Number(current!.reminderLeadMinutes),
        locationVersion: Number(current!.locationVersion)
      }
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const invoice = await openInvoice();
    const header = (await receipt(invoice.id)).json().invoice;
    expect(header.businessName).toBe("Payment Salon");
    expect(header.businessPhone).toBe("555-0199");
    expect(header.businessEmail).toBe("front-desk@payment.test");
    expect(header.currency).toBe(current!.currency);

    // `locations.address` IS DELIBERATELY ABSENT and this asserts the absence rather than leaving
    // it to be noticed. The column exists, but nothing in the product writes it - the create path
    // inserts (business_id, name, timezone), `businessSettingsSchema` has no address field, and
    // the settings route's `update locations set` touches only name and timezone. The only writer
    // in the repository is `scripts/seed-qa.ts`, which is the trap: an address line built on this
    // would render in QA and be blank for every real salon. Adding it needs the settings form
    // first, and this assertion is what will fail to remind whoever does it.
    expect(header).not.toHaveProperty("locationAddress");
    const [location] = await db<{ address: string | null }[]>`
      select address from locations where business_id=${businessId} and active
    `;
    expect(location!.address).toBeNull();
  });
});
