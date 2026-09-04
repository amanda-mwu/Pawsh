import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * THE CURRENCY LOCK, exercised through the route an operator actually reaches.
 *
 * `businesses.currency` is not a label on the settings screen - it is the denomination every
 * amount in the product is READ in. `invoices`, `invoice_items`, `payments` and
 * `customer_credit_entries` all store bare minor units; only `square_terminal_checkouts.currency`
 * and `payment_refunds.currency` carry their own. So changing this column after money has been
 * recorded relabels a year of takings without touching a single integer, and the salon's books,
 * its receipts and its tax return stop agreeing with what the customer paid.
 *
 * Every case here goes through `PUT /api/business/settings`, because that route is the only
 * writer of the column and therefore the only place the rule can be enforced. Nothing in this
 * file asserts against a helper the route does not call.
 *
 * WHAT THE THRESHOLD IS: the EXISTENCE of an invoice, a payment (voided or not), a refund, or a
 * client credit entry. Not a balance, not a status, not a total. Two of the cases below exist
 * purely to hold that line - a voided payment and a credit ledger that nets to zero both still
 * refuse, because both are history a person can be asked about.
 *
 * WHAT IT IS NOT: the priced services `provisionBusinessCatalog` seeds at signup. Those are
 * configuration, and counting them would lock every workspace's currency before its owner had
 * seen a single screen. The second case proves a workspace with a full priced catalog and an
 * operator-priced service of its own can still choose its currency.
 *
 * ONE HONEST LIMIT ON ISOLATION. `payments` references `invoices` and `payment_refunds`
 * references both, so a workspace holding a payment or a refund necessarily holds an invoice too:
 * those arms of the check cannot be observed alone through any legal database state. The invoice
 * and client-credit arms CAN be, and are, isolated below. The payment, voided-payment and refund
 * cases are still worth their rows: each is a position an operator can genuinely be sitting in,
 * and each would have to keep refusing if the invoice arm were ever narrowed.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "currency-lock-secret-at-least-thirty-two-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("the business currency lock", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let day = 1;

  const key = () => crypto.randomUUID();

  /**
   * A whole workspace of its own for each case, because the rule is a property of ONE business's
   * history and a shared fixture would let one case's invoice decide another case's answer.
   */
  async function workspace(name: string) {
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `currency-lock-${crypto.randomUUID()}@example.test`,
        password: "correct horse currency lock", businessName: name
      }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    const ownerCookie = cookie(signup);
    const { businessId, locationId } = signup.json() as { businessId: string; locationId: string };

    const post = (
      url: string, payload: Record<string, unknown>, headers: Record<string, string> = {}
    ) => app.inject({ method: "POST", url, headers: { cookie: ownerCookie, ...headers }, payload });

    const me = async () => (await app.inject({
      method: "GET", url: "/api/me", headers: { cookie: ownerCookie }
    })).json();

    /**
     * The whole record, exactly as the Business settings form posts it. That shape matters to the
     * rule: the form resends the currency it read on every unrelated save, so a lock that refused
     * on the PRESENCE of the field rather than on a CHANGE would break renaming the salon.
     */
    const save = async (payload: Record<string, unknown>) => {
      const current = await me();
      return app.inject({
        method: "PUT", url: "/api/business/settings",
        headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
        payload: {
          name: current.business.name, timezone: current.business.timezone,
          taxRateBasisPoints: current.business.taxRateBasisPoints,
          reminderLeadMinutes: current.business.reminderLeadMinutes,
          locationVersion: current.business.locationVersion,
          ...payload
        }
      });
    };

    const storedCurrency = async () => (await db<{ currency: string }[]>`
      select currency from businesses where id=${businessId}
    `)[0]!.currency;

    /** Everything a bill needs, created only by the cases that actually take money. */
    async function billingFixtures() {
      const serviceId = (await post("/api/services", {
        name: "Currency Groom", baseDurationMinutes: 60, basePriceMinor: 10_000
      })).json().id as string;
      const employeeId = (await post("/api/employees", {
        displayName: "Currency Groomer", serviceIds: [serviceId]
      })).json().id as string;
      const customerId = (await post("/api/customers", {
        firstName: "Currency", lastName: "Client", phone: "555-0199"
      })).json().id as string;
      const petId = (await post("/api/pets", {
        customerId, name: "Currency Pet", species: "dog", breed: "Poodle"
      })).json().id as string;
      return { serviceId, employeeId, customerId, petId };
    }

    /** A completed appointment carrying one 10000-minor service snapshot, ready to check out. */
    async function completedAppointment(fixtures: Awaited<ReturnType<typeof billingFixtures>>) {
      const stamp = String(day++).padStart(2, "0");
      const start = `2034-07-${stamp}T16:00:00.000Z`;
      const end = `2034-07-${stamp}T17:00:00.000Z`;
      const [appointment] = await db<{ id: string }[]>`
        insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
          scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
        select ${businessId},${locationId},${fixtures.customerId},${fixtures.petId},${fixtures.employeeId},
          ${start}::timestamptz,${end}::timestamptz,'America/Los_Angeles',
          ${start}::timestamptz at time zone 'America/Los_Angeles',-420,'completed',user_id,user_id
        from business_memberships where business_id=${businessId} and is_owner returning id
      `;
      await db`
        insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
          duration_minutes_snapshot,price_minor_snapshot)
        values (${businessId},${appointment!.id},${fixtures.serviceId},'Currency Groom',60,10000)
      `;
      return appointment!.id;
    }

    /** An open, unpaid invoice raised the way checkout raises one. */
    async function openInvoice() {
      const fixtures = await billingFixtures();
      const created = await post(
        `/api/appointments/${await completedAppointment(fixtures)}/checkout`,
        { discountMinor: 0, discountType: null, tipMinor: 0 },
        { "idempotency-key": key() }
      );
      expect(created.statusCode, created.body).toBe(201);
      const invoice = created.json() as { id: string; balanceMinor: number };
      return { fixtures, invoice };
    }

    const pay = (invoiceId: string, amountMinor: number, expectedBalanceMinor: number) =>
      post(`/api/invoices/${invoiceId}/payments`,
        { amountMinor, expectedBalanceMinor, method: "cash", externalReference: null },
        { "idempotency-key": key() });

    const voidPayment = (paymentId: string, reason: string) =>
      post(`/api/payments/${paymentId}/void`, { reason }, { "idempotency-key": key() });

    const credit = (customerId: string, kind: string, amountMinor: number, reason: string) =>
      post(`/api/customers/${customerId}/credit`, { kind, amountMinor, reason },
        { "idempotency-key": key() });

    const addCustomer = async (firstName: string, phone: string) =>
      (await post("/api/customers", { firstName, lastName: "Client", phone })).json().id as string;

    return {
      businessId, locationId, cookie: ownerCookie, post,
      me, save, storedCurrency, openInvoice, pay, voidPayment, credit, addCustomer
    };
  }

  type Workspace = Awaited<ReturnType<typeof workspace>>;

  /** The one assertion the refusal contract is made of, so no case can quietly assert less. */
  async function expectLocked(business: Workspace, requested: string) {
    const before = await business.storedCurrency();
    const refused = await business.save({ currency: requested });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe("CURRENCY_LOCKED_BY_FINANCIAL_HISTORY");
    expect(String(refused.json().error)).toContain(before);
    // Refused AND not written. A 409 that had already moved the column would be worse than no
    // check at all, because the operator would be told it failed while the books were relabelled.
    expect(await business.storedCurrency()).toBe(before);
    return refused;
  }

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
  }, 30_000);
  afterAll(async () => { await app.close(); await db.end(); });

  it("lets a workspace with no financial history choose its currency", async () => {
    const business = await workspace("Fresh Currency Salon");
    expect(await business.storedCurrency()).toBe("USD");
    const saved = await business.save({ currency: "EUR" });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await business.storedCurrency()).toBe("EUR");
  }, 30_000);

  it("does not count priced services as financial history", async () => {
    const business = await workspace("Seeded Catalog Salon");
    // The seeded catalog really is there and really is priced, which is what makes this case a
    // test rather than a restatement of the previous one.
    const [seeded] = await db<{ priced: number }[]>`
      select count(*)::int as priced from services
      where business_id=${business.businessId} and base_price_minor > 0
    `;
    expect(seeded!.priced).toBeGreaterThan(0);
    // And a service the operator priced themselves afterwards is configuration too.
    const added = await business.post("/api/services", {
      name: "Hand Strip", baseDurationMinutes: 90, basePriceMinor: 14_500
    });
    expect(added.statusCode, added.body).toBe(201);
    const saved = await business.save({ currency: "GBP" });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await business.storedCurrency()).toBe("GBP");
  }, 30_000);

  it("refuses once an unpaid invoice exists", async () => {
    // The isolated invoice arm: one invoice, no payment, nothing settled, no money moved yet.
    const business = await workspace("Unpaid Invoice Salon");
    const { invoice } = await business.openInvoice();
    const [row] = await db<{ status: string; balanceMinor: number }[]>`
      select status, balance_minor from invoices where id=${invoice.id}
    `;
    expect(row!.balanceMinor).toBeGreaterThan(0);
    expect(row!.status).not.toBe("paid");
    const [payments] = await db<{ count: number }[]>`
      select count(*)::int as count from payments where business_id=${business.businessId}
    `;
    expect(payments!.count).toBe(0);
    await expectLocked(business, "EUR");
  }, 30_000);

  it("refuses once an invoice has been paid in full", async () => {
    const business = await workspace("Paid Invoice Salon");
    const { invoice } = await business.openInvoice();
    const paid = await business.pay(invoice.id, invoice.balanceMinor, invoice.balanceMinor);
    expect(paid.statusCode, paid.body).toBe(201);
    await expectLocked(business, "EUR");
  }, 30_000);

  it("refuses once a payment has been recorded", async () => {
    const business = await workspace("Payment Salon");
    const { invoice } = await business.openInvoice();
    const part = Math.floor(invoice.balanceMinor / 4);
    const paid = await business.pay(invoice.id, part, invoice.balanceMinor);
    expect(paid.statusCode, paid.body).toBe(201);
    const [payment] = await db<{ status: string }[]>`
      select status from payments where business_id=${business.businessId}
    `;
    expect(payment!.status).toBe("recorded");
    await expectLocked(business, "EUR");
  }, 30_000);

  it("still refuses when the only payment was voided", async () => {
    // THE CASE THE RULE IS ABOUT. A void removes Pawsh's record of money, not the money's history:
    // the receipt went out in the old currency and the customer can still ask about it. The check
    // must therefore ask whether the row EXISTS, never whether it is still active.
    const business = await workspace("Voided Payment Salon");
    const { invoice } = await business.openInvoice();
    const paid = await business.pay(invoice.id, invoice.balanceMinor, invoice.balanceMinor);
    expect(paid.statusCode, paid.body).toBe(201);
    const [payment] = await db<{ id: string }[]>`
      select id from payments where business_id=${business.businessId}
    `;
    const voided = await business.voidPayment(payment!.id, "Rang it up on the wrong client");
    expect(voided.statusCode, voided.body).toBe(200);
    const [after] = await db<{ status: string }[]>`
      select status from payments where id=${payment!.id}
    `;
    expect(after!.status).toBe("voided");
    await expectLocked(business, "EUR");
  }, 30_000);

  it("refuses once a refund has been raised", async () => {
    const business = await workspace("Refund Salon");
    const { invoice } = await business.openInvoice();
    const paid = await business.pay(invoice.id, invoice.balanceMinor, invoice.balanceMinor);
    expect(paid.statusCode, paid.body).toBe(201);
    const [payment] = await db<{ id: string }[]>`
      select id from payments where business_id=${business.businessId}
    `;
    // Written directly rather than through `POST /api/payments/:id/refunds`, which needs a
    // connected Square merchant and a provider payment; `payment-refunds.test.ts` owns that path.
    // What is under test here is that the `payment_refunds` arm of the existence check is real,
    // and a row with the columns the route writes is exactly what it has to see.
    await db`
      insert into payment_refunds(business_id,payment_id,invoice_id,amount_minor,currency,
        idempotency_key,requested_by,status)
      select ${business.businessId},${payment!.id},${invoice.id},2500,'USD',
        ${crypto.randomUUID()},user_id,'pending'
      from business_memberships where business_id=${business.businessId} and is_owner
    `;
    await expectLocked(business, "EUR");
  }, 30_000);

  it("refuses on a client credit entry with no invoice anywhere in the workspace", async () => {
    // The isolated credit arm. This workspace has never raised an invoice or taken a payment, so
    // nothing but `customer_credit_entries` can be producing the refusal.
    const business = await workspace("Credit Grant Salon");
    const customerId = await business.addCustomer("Credit", "555-0177");
    const granted = await business.credit(customerId, "grant", 5_000, "Goodwill after a late start");
    expect(granted.statusCode, granted.body).toBe(201);
    const [counts] = await db<{ invoices: number; payments: number; entries: number }[]>`
      select
        (select count(*)::int from invoices where business_id=${business.businessId}) as invoices,
        (select count(*)::int from payments where business_id=${business.businessId}) as payments,
        (select count(*)::int from customer_credit_entries
          where business_id=${business.businessId}) as entries
    `;
    expect(counts).toMatchObject({ invoices: 0, payments: 0, entries: 1 });
    await expectLocked(business, "EUR");
  }, 30_000);

  it("still refuses when the credit ledger nets back to zero", async () => {
    // THE SECOND CASE THE RULE IS ABOUT. A balance of zero is not an absence of history: the grant
    // and the clawback are two lines a client can dispute, and both were denominated. A check that
    // summed the ledger instead of asking whether it has rows would unlock this workspace.
    const business = await workspace("Net Zero Credit Salon");
    const customerId = await business.addCustomer("Zero", "555-0166");
    expect((await business.credit(customerId, "grant", 5_000, "Goodwill")).statusCode).toBe(201);
    expect((await business.credit(customerId, "adjustment", -5_000, "Granted in error")).statusCode)
      .toBe(201);
    const [ledger] = await db<{ entries: number; balance: number }[]>`
      select count(*)::int as entries, coalesce(sum(amount_minor),0)::int as balance
      from customer_credit_entries where business_id=${business.businessId}
    `;
    expect(ledger).toMatchObject({ entries: 2, balance: 0 });
    await expectLocked(business, "EUR");
  }, 30_000);

  it("keeps saving the same currency allowed after history exists", async () => {
    // Not a nicety. The Business settings form posts the whole record, so this is what happens
    // every time an operator renames the salon or edits its tax rate once a single invoice exists.
    const business = await workspace("Unchanged Currency Salon");
    const { invoice } = await business.openInvoice();
    expect((await business.pay(invoice.id, invoice.balanceMinor, invoice.balanceMinor)).statusCode)
      .toBe(201);

    const resent = await business.save({ currency: "USD" });
    expect(resent.statusCode, resent.body).toBe(200);
    const renamed = await business.save({ currency: "USD", name: "Unchanged Currency Grooming" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    // A save that never mentions the currency at all is the other half of the same guarantee.
    const untouched = await business.save({ taxRateBasisPoints: 725 });
    expect(untouched.statusCode, untouched.body).toBe(200);
    expect(await business.storedCurrency()).toBe("USD");
    expect((await business.me()).business.name).toBe("Unchanged Currency Grooming");
  }, 30_000);

  it("never lets one workspace's financial history lock another's currency", async () => {
    // The check is an EXISTENCE query. An unscoped one would be true for every business on the
    // server the moment any single salon raised an invoice, and the first workspace to open its
    // settings screen would find a setting it had never used already frozen.
    const busy = await workspace("Busy Neighbour Salon");
    const { invoice } = await busy.openInvoice();
    expect((await busy.pay(invoice.id, invoice.balanceMinor, invoice.balanceMinor)).statusCode)
      .toBe(201);
    const customerId = await busy.addCustomer("Busy", "555-0144");
    expect((await busy.credit(customerId, "grant", 2_500, "Goodwill")).statusCode).toBe(201);
    await expectLocked(busy, "EUR");

    const quiet = await workspace("Quiet Neighbour Salon");
    const saved = await quiet.save({ currency: "CAD" });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await quiet.storedCurrency()).toBe("CAD");
    // And the busy neighbour is still on the currency its history pinned it to.
    expect(await busy.storedCurrency()).toBe("USD");
  }, 30_000);

  it("does not rewrite or convert a single historical amount when it refuses", async () => {
    // The refusal exists to keep stored money meaning what it meant. A refusal that "helpfully"
    // converted the rows would be the very defect this rule was written against.
    const business = await workspace("Untouched Amounts Salon");
    const { invoice } = await business.openInvoice();
    expect((await business.pay(invoice.id, 4_000, invoice.balanceMinor)).statusCode).toBe(201);
    const snapshot = async () => await db<Record<string, unknown>[]>`
      select i.total_minor, i.balance_minor, i.subtotal_minor, i.tax_minor, i.status,
        p.amount_minor as payment_minor, p.status as payment_status
      from invoices i join payments p on p.business_id=i.business_id and p.invoice_id=i.id
      where i.business_id=${business.businessId}
    `;
    const before = [...await snapshot()];
    await expectLocked(business, "MXN");
    expect([...await snapshot()]).toEqual(before);
  }, 30_000);
});
