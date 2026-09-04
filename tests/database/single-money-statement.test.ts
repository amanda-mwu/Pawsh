import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "single-money-statement-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

function cookie(response: { headers: Record<string, unknown> }): string {
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

/**
 * SINGLE MONEY STATEMENT, the database half.
 *
 * The receipt is the one document that states a client's money, and it is asserted in two places.
 * The browser half compares the three hosts that render `receiptBodyMarkup` - the settled Check Out
 * panel, the receipt modal and the print root - and fails when they drift. This is the other half,
 * and it is the one that answers the harder question: not "do the three surfaces agree with each
 * other" but "does the one answer they all render agree with the rows it was composed from". Three
 * surfaces can agree perfectly about a number the ledger never recorded.
 *
 * The Ticket is deliberately not among those hosts. It is a printable work sheet and states no
 * money at all, which is the only reason any surface sits outside this rule - see the amendment at
 * the head of ADR-011.
 *
 * Three equalities, and each is a place two writers could otherwise disagree:
 *
 *   sum(invoice_discounts.applied_minor) = invoices.discount_minor
 *       The aggregate is what the fold produced; the rows are the steps that produced it. A
 *       receipt prints the steps and every other surface prints the aggregate, so a bill whose
 *       steps do not sum to its total is a bill that says two different things about the same
 *       money depending on which surface you opened.
 *
 *   sum(payments where status='recorded') = total_minor - balance_minor
 *       What has been collected, against what the invoice says is left. `applyInvoiceSettlement`
 *       is the single writer of `balance_minor` precisely so this cannot drift; this is the
 *       assertion that says so out loud rather than by reading it.
 *
 *   every client_credit payment has EXACTLY ONE redemption entry, negated - and after a void,
 *   exactly one redemption_reversal
 *       `customer_credit_redemption_per_payment` in 0050 makes it AT MOST one. At most one is
 *       satisfied by none, and none is a credit payment on the receipt that the client's own
 *       ledger never recorded - money spent from a balance that never moved. Exactly one, with
 *       the right sign, is the property; the index is only half of it.
 *
 * Every invoice here is built through the real routes - checkout, payments, void - and never by
 * inserting rows. An invariant asserted over hand-written rows is an assertion about the fixture.
 *
 * THE CASE THIS FILE EXISTS FOR is the bill settled partly in cash and partly from a credit
 * balance. It is where the receipt and the ledger drift most easily, because credit is the one figure
 * that lives in two tables at once: a `payments` row that settles the bill and a
 * `customer_credit_entries` row that debits the account, written in one transaction and readable
 * from two entirely separate screens.
 */
describeDatabase("single money statement", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie = "";
  let businessId = "", locationId = "", employeeId = "", serviceId = "";
  let customerId = "", petId = "";
  const suffix = crypto.randomUUID();
  const key = (): string => crypto.randomUUID();

  // 8.75%, deliberately not zero. The neighbouring suites zero the rate so their assertions are
  // about the discount rather than about rounding; this one wants the tax line present, because
  // 0050's whole reason for making credit a payment rather than a discount is that the two land on
  // opposite sides of it.
  const taxRateBasisPoints = 875;
  const taxed = (net: number): number => net + Math.round((net * taxRateBasisPoints) / 10_000);

  async function newClient(firstName: string, lastName: string) {
    const customer = (await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName, lastName, preferredContactMethod: "none" }
    })).json().id as string;
    const pet = (await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId: customer, name: `${firstName} Pet`, species: "dog" }
    })).json().id as string;
    return { customerId: customer, petId: pet };
  }

  /** A completed appointment carrying one service snapshot, on its own day so none collide. */
  let nextDay = 1;
  async function completedAppointment(
    priceMinor = 10_000, client?: { customerId: string; petId: string }
  ): Promise<string> {
    const day = String(2 + (nextDay += 1) % 24).padStart(2, "0");
    const startAtUtc = `2036-03-${day}T16:00:00.000Z`;
    const endAtUtc = new Date(new Date(startAtUtc).getTime() + 3_600_000).toISOString();
    const [appointment] = await db<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      select ${businessId},${locationId},${client?.customerId ?? customerId},
        ${client?.petId ?? petId},${employeeId},
        ${startAtUtc}::timestamptz,${endAtUtc}::timestamptz,'America/Los_Angeles',
        ${startAtUtc}::timestamptz at time zone 'America/Los_Angeles',
        extract(epoch from ((${startAtUtc}::timestamptz at time zone 'America/Los_Angeles')
          -(${startAtUtc}::timestamptz at time zone 'UTC')))/60,'completed',user_id,user_id
      from business_memberships where business_id=${businessId} and is_owner returning id
    `;
    await db`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
        duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment!.id},${serviceId},'Statement Groom',60,${priceMinor})
    `;
    return appointment!.id;
  }

  interface OpenInvoice {
    id: string; subtotalMinor: number; discountMinor: number; taxMinor: number;
    tipMinor: number; totalMinor: number; balanceMinor: number; status: string;
  }

  /** A completed appointment taken through the real checkout. Returns the created invoice. */
  async function openInvoice(
    options: {
      priceMinor?: number; client?: { customerId: string; petId: string };
      payload?: Record<string, unknown>;
    } = {}
  ): Promise<OpenInvoice> {
    const appointmentId = await completedAppointment(options.priceMinor ?? 10_000, options.client);
    const response = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
      headers: { cookie: ownerCookie, "idempotency-key": key() },
      payload: { discountMinor: 0, tipMinor: 0, appliedDiscountIds: [], ...options.payload }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as OpenInvoice;
  }

  async function createDiscount(payload: Record<string, unknown>): Promise<string> {
    const response = await app.inject({
      method: "POST", url: "/api/settings/discounts", headers: { cookie: ownerCookie }, payload
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().createdId as string;
  }

  async function grant(amountMinor: number, reason: string, who = customerId) {
    const response = await app.inject({
      method: "POST", url: `/api/customers/${who}/credit`,
      headers: { cookie: ownerCookie, "idempotency-key": key() },
      payload: { kind: "grant", amountMinor, reason }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response;
  }

  async function pay(
    invoiceId: string, amountMinor: number, expectedBalanceMinor: number, method = "cash"
  ) {
    const response = await app.inject({
      method: "POST", url: `/api/invoices/${invoiceId}/payments`,
      headers: { cookie: ownerCookie, "idempotency-key": key() },
      payload: { amountMinor, expectedBalanceMinor, method }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; balance: number; creditRemainingMinor: number | null };
  }

  async function voidPayment(paymentId: string, reason = "Keyed the wrong tender") {
    const response = await app.inject({
      method: "POST", url: `/api/payments/${paymentId}/void`,
      headers: { cookie: ownerCookie, "idempotency-key": key() },
      payload: { reason }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { id: string; balance: number };
  }

  async function receipt(invoiceId: string) {
    const response = await app.inject({
      method: "GET", url: `/api/invoices/${invoiceId}/receipt`, headers: { cookie: ownerCookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  /**
   * The three equalities, over one invoice, read from the tables rather than from any payload.
   *
   * Nothing here goes through the receipt endpoint on purpose: the point is to check the rows the
   * projection is composed FROM, so that a projection which quietly agrees with itself cannot pass.
   */
  async function reconcile(invoiceId: string): Promise<void> {
    const [invoice] = await db<{
      totalMinor: number; balanceMinor: number; discountMinor: number; status: string;
    }[]>`
      select total_minor,balance_minor,discount_minor,status from invoices
      where business_id=${businessId} and id=${invoiceId}
    `;
    expect(invoice, `invoice ${invoiceId} is missing`).toBeTruthy();

    const [steps] = await db<{ appliedMinor: number }[]>`
      select coalesce(sum(applied_minor),0)::int as applied_minor from invoice_discounts
      where business_id=${businessId} and invoice_id=${invoiceId}
    `;
    expect(steps!.appliedMinor, `discount steps on ${invoiceId}`).toBe(invoice!.discountMinor);

    const [collected] = await db<{ paidMinor: number }[]>`
      select coalesce(sum(amount_minor),0)::int as paid_minor from payments
      where business_id=${businessId} and invoice_id=${invoiceId} and status='recorded'
    `;
    expect(collected!.paidMinor, `recorded payments on ${invoiceId}`)
      .toBe(invoice!.totalMinor - invoice!.balanceMinor);

    const creditPayments = await db<{ id: string; amountMinor: number; status: string }[]>`
      select id,amount_minor,status from payments
      where business_id=${businessId} and invoice_id=${invoiceId} and method='client_credit'
      order by recorded_at,id
    `;
    for (const payment of creditPayments) {
      const entries = await db<{ kind: string; amountMinor: number }[]>`
        select kind,amount_minor from customer_credit_entries
        where business_id=${businessId} and payment_id=${payment.id}
      `;
      const redemptions = entries.filter((entry) => entry.kind === "redemption");
      const reversals = entries.filter((entry) => entry.kind === "redemption_reversal");
      // EXACTLY one, not at most one. The index in 0050 gives the upper bound; a credit payment
      // with no redemption row at all would satisfy that index and still be money the client's
      // ledger never saw leave their account.
      expect(redemptions, `redemption for payment ${payment.id}`).toHaveLength(1);
      expect(redemptions[0]!.amountMinor, `redemption sign for payment ${payment.id}`)
        .toBe(-payment.amountMinor);
      // `payment_status` is 'recorded' or 'voided' and nothing else, so this is a total rule
      // rather than a case that skips whatever it does not recognise.
      expect(reversals, `reversal for payment ${payment.id}`)
        .toHaveLength(payment.status === "voided" ? 1 : 0);
      if (payment.status === "voided") {
        expect(reversals[0]!.amountMinor).toBe(payment.amountMinor);
      }
      // And the payment attracted no OTHER kind of ledger row. A grant or an adjustment naming a
      // payment is refused by `credit_entry_source_reference`, so this is the assertion that the
      // constraint is still doing that.
      expect(entries).toHaveLength(redemptions.length + reversals.length);
    }
  }

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `salon-statement-${suffix}@example.test`,
        password: "correct horse salon statement", businessName: "Statement Salon"
      }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());

    const settings = await app.inject({
      method: "PUT", url: "/api/business/settings", headers: { cookie: ownerCookie },
      payload: {
        name: "Statement Salon", timezone: "America/Los_Angeles", currency: "USD",
        taxRateBasisPoints, reminderLeadMinutes: 1440, locationVersion: 1
      }
    });
    expect(settings.statusCode, settings.body).toBe(200);

    serviceId = (await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name: "Statement Groom", baseDurationMinutes: 60, basePriceMinor: 10_000 }
    })).json().id;
    employeeId = (await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: "Statement Groomer", serviceIds: [serviceId] }
    })).json().id;
    ({ customerId, petId } = await newClient("State", "Ment"));
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await db?.end({ timeout: 5 });
  });

  it("reconciles a plain bill before and after it is settled in cash", async () => {
    const invoice = await openInvoice();
    expect(invoice).toMatchObject({
      subtotalMinor: 10_000, discountMinor: 0, totalMinor: taxed(10_000), status: "open"
    });
    // An invoice nobody has paid still has to reconcile: no discount steps against a zero
    // aggregate, and no payments against a balance equal to the total.
    await reconcile(invoice.id);

    const part = 4_000;
    await pay(invoice.id, part, invoice.balanceMinor);
    await reconcile(invoice.id);

    const remainder = invoice.balanceMinor - part;
    await pay(invoice.id, remainder, remainder);
    await reconcile(invoice.id);
    const [settled] = await db<{ status: string; balanceMinor: number }[]>`
      select status,balance_minor from invoices where business_id=${businessId} and id=${invoice.id}
    `;
    expect(settled).toMatchObject({ status: "paid", balanceMinor: 0 });
  });

  it("reconciles a compounded discount stack against the aggregate the invoice carries", async () => {
    const twentyOff = await createDiscount({
      name: "Statement twenty off", kind: "amount", amountMinor: 2_000
    });
    const tenPercent = await createDiscount({
      name: "Statement ten percent", kind: "percentage", rateBasisPoints: 1_000
    });
    expect((await app.inject({
      method: "PUT", url: "/api/settings/discount-stacking",
      headers: { cookie: ownerCookie }, payload: { stackingMode: "amount_first" }
    })).statusCode).toBe(200);

    // $100, $20 off, then 10% of the $80 that remained: two steps summing to $28.
    const invoice = await openInvoice({
      payload: { appliedDiscountIds: [tenPercent, twentyOff] }
    });
    expect(invoice).toMatchObject({
      subtotalMinor: 10_000, discountMinor: 2_800, totalMinor: taxed(7_200)
    });
    const rows = await db<{ appliedMinor: number }[]>`
      select applied_minor from invoice_discounts
      where business_id=${businessId} and invoice_id=${invoice.id} order by line_position
    `;
    // TWO steps, not one aggregate row. The invariant is only worth asserting where the two
    // representations are actually different shapes.
    expect(rows.map((row) => row.appliedMinor)).toEqual([2_000, 800]);
    await reconcile(invoice.id);

    // The manual path snapshots a step of its own, which is what makes the equality TOTAL rather
    // than a rule with a keyed-in-amount exception.
    const manual = await openInvoice({
      payload: { discountMinor: 1_500, discountType: "courtesy" }
    });
    expect(manual.discountMinor).toBe(1_500);
    await reconcile(manual.id);

    // A bill discounted to nothing: 'paid' on creation, with no payment row behind it. The second
    // equality is easiest to get wrong here, because a settled invoice usually has payments.
    const free = await openInvoice({
      payload: { discountMinor: 10_000, discountType: "comped" }
    });
    expect(free).toMatchObject({ discountMinor: 10_000, totalMinor: 0, balanceMinor: 0, status: "paid" });
    await reconcile(free.id);
  });

  it("reconciles a bill settled partly in cash and partly from a credit balance", async () => {
    // THE CASE THE FILE EXISTS FOR. Credit is the one figure held in two tables at once, and it
    // reaches the receipt as a payment row and as nothing else.
    const client = await newClient("Cred", "Split");
    await grant(4_000, "Rebooking courtesy", client.customerId);

    const invoice = await openInvoice({ client });
    const fromCredit = 4_000;
    const spend = await pay(invoice.id, fromCredit, invoice.balanceMinor, "client_credit");
    expect(spend.creditRemainingMinor).toBe(0);
    await reconcile(invoice.id);

    const inCash = invoice.balanceMinor - fromCredit;
    await pay(invoice.id, inCash, inCash, "cash");
    await reconcile(invoice.id);

    // The receipt projection composed from those rows says the same thing. Credit is a PAYMENT and
    // never a discount - migration 0050 - so it reduces the balance without moving the taxable
    // base, and `receipt.discounts` stays empty on a bill that had no discount.
    const settled = await receipt(invoice.id);
    expect(settled.invoice).toMatchObject({ status: "paid", balanceMinor: 0, discountMinor: 0 });
    expect(settled.discounts).toEqual([]);
    expect(settled.payments.map((payment: { method: string; amountMinor: number }) =>
      [payment.method, payment.amountMinor])).toEqual([["client_credit", fromCredit], ["cash", inCash]]);
    expect(settled.invoice.taxMinor).toBe(taxed(10_000) - 10_000);

    // And the ledger agrees with the payment row it was written beside.
    const [ledger] = await db<{ balanceMinor: number }[]>`
      select coalesce(sum(amount_minor),0)::int as balance_minor from customer_credit_entries
      where business_id=${businessId} and customer_id=${client.customerId}
    `;
    expect(ledger!.balanceMinor).toBe(0);
  });

  it("writes exactly one reversal when a credit payment is voided, and reconciles again", async () => {
    const client = await newClient("Void", "Credit");
    await grant(5_000, "Goodwill after a late finish", client.customerId);

    const invoice = await openInvoice({ client });
    const spend = await pay(invoice.id, 5_000, invoice.balanceMinor, "client_credit");
    const cash = await pay(invoice.id, 2_000, invoice.balanceMinor - 5_000, "cash");
    await reconcile(invoice.id);

    const voided = await voidPayment(spend.id, "Client asked to keep the credit");
    // The bill is collectable again by exactly what the credit had settled, and `reconcile` now
    // requires the reversal to exist rather than merely permitting it.
    expect(voided.balance).toBe(invoice.balanceMinor - 2_000);
    await reconcile(invoice.id);

    // Voiding the cash payment beside it writes NO ledger row at all. Only credit came off a
    // balance, so only credit has anywhere to go back to.
    const before = await db<{ id: string }[]>`
      select id from customer_credit_entries
      where business_id=${businessId} and customer_id=${client.customerId}
    `;
    await voidPayment(cash.id, "Cash was never handed over");
    const after = await db<{ id: string }[]>`
      select id from customer_credit_entries
      where business_id=${businessId} and customer_id=${client.customerId}
    `;
    expect(after).toHaveLength(before.length);
    await reconcile(invoice.id);

    // The money is back on the account in full, and the invoice owes its whole total again.
    const [ledger] = await db<{ balanceMinor: number }[]>`
      select coalesce(sum(amount_minor),0)::int as balance_minor from customer_credit_entries
      where business_id=${businessId} and customer_id=${client.customerId}
    `;
    expect(ledger!.balanceMinor).toBe(5_000);
    const [reopened] = await db<{ balanceMinor: number; totalMinor: number }[]>`
      select balance_minor,total_minor from invoices
      where business_id=${businessId} and id=${invoice.id}
    `;
    expect(reopened!.balanceMinor).toBe(reopened!.totalMinor);
  });

  it("holds over every invoice this suite built, not only the ones it looked at", async () => {
    // The invariant ADR-011 states is universally quantified, so the last assertion is a sweep
    // rather than another example. It runs over every invoice this business wrote - including the
    // ones the cases above created only as fixtures and never asserted anything about.
    const invoices = await db<{ id: string }[]>`
      select id from invoices where business_id=${businessId} order by created_at,id
    `;
    expect(invoices.length).toBeGreaterThan(5);
    for (const invoice of invoices) await reconcile(invoice.id);

    // And there is no orphan on the other side: every redemption and every reversal in this
    // business names a payment that still exists and belongs to the invoice the entry claims.
    const orphans = await db<{ id: string }[]>`
      select entry.id from customer_credit_entries entry
      left join payments payment
        on payment.business_id=entry.business_id and payment.id=entry.payment_id
        and payment.invoice_id=entry.invoice_id
      where entry.business_id=${businessId}
        and entry.kind in ('redemption','redemption_reversal') and payment.id is null
    `;
    expect(orphans).toEqual([]);
  });
});
