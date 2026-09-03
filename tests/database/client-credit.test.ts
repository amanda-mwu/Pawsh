import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { tokenHash } from "../../src/http/context.js";
import { roleFor } from "../support/roles.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "client-credit-test-secret-at-least-32-characters",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

function cookie(response: { headers: Record<string, unknown> }): string {
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

interface CreditEntry {
  id: string; kind: string; amountMinor: number; balanceAfterMinor: number;
  reason: string | null; invoiceId: string | null; invoiceNumber: string | null;
  paymentId: string | null; createdAt: string; createdBy: string | null;
  createdByName: string | null; pairId: string | null; reversesEntryId: string | null;
  reversedAt: string | null; correctsEntryId: string | null; correctedAt: string | null;
}

interface CreditRead {
  balanceMinor: number; grantedMinor: number; usedMinor: number;
  entryCount: number; entryTotal: number; entries: CreditEntry[];
  entryKinds: { value: string; label: string }[]; canEdit: boolean;
}

/**
 * Client credit: an append-only ledger, spent as a payment, reversed only to itself.
 *
 * The properties worth holding are that THE BALANCE IS A SUM AND NOTHING ELSE, that the sum is
 * enforced under a ROW LOCK rather than by a constraint no database could express, that a ledger
 * row can never be edited or deleted, that voiding a credit payment returns the money to the one
 * place it could have come from, that GRANTING and APPLYING are separate permissions, and that a
 * balance is WITHHELD rather than zeroed from somebody who may not see money.
 */
describeDatabase("client credit", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie = "", rivalCookie = "";
  let receptionistCookie = "", granterBlindCookie = "", viewerCookie = "";
  let businessId = "", locationId = "", employeeId = "", serviceId = "";
  let customerId = "", petId = "";
  const suffix = crypto.randomUUID();
  const key = (): string => crypto.randomUUID();

  async function seatMember(label: string, permissions: readonly string[]): Promise<string> {
    const token = crypto.randomUUID();
    const email = `${label}-${suffix}@example.test`;
    const [member] = await db<{ userId: string }[]>`
      with account as (
        insert into users(email,normalized_email,password_hash)
        values (${email},${email},${await hashPassword("correct horse credit member")})
        returning id
      )
      insert into business_memberships(business_id,user_id,role_id)
      select ${businessId},id,${await roleFor(db, businessId, permissions)} from account
      returning user_id
    `;
    await db`
      insert into sessions(user_id,token_hash,expires_at)
      values (${member!.userId},${tokenHash(token)},now()+interval '1 day')
    `;
    return `pawsh_session=${token}`;
  }

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

  /** A completed appointment priced at `priceMinor`, on its own day so none ever collide. */
  let nextDay = 1;
  async function completedAppointment(
    priceMinor = 5_000, client?: { customerId: string; petId: string }
  ): Promise<string> {
    const day = String(2 + (nextDay += 1) % 24).padStart(2, "0");
    const startAtUtc = `2035-05-${day}T16:00:00.000Z`;
    const endAtUtc = new Date(new Date(startAtUtc).getTime() + 3_600_000).toISOString();
    const [appointment] = await db<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      select ${businessId},${locationId},${client?.customerId ?? customerId},
        ${client?.petId ?? petId},${employeeId},
        ${startAtUtc}::timestamptz,${endAtUtc}::timestamptz,'America/Los_Angeles',
        ${`2035-05-${day}T09:00`},-420,'completed',user_id,user_id
      from business_memberships where business_id=${businessId} and is_owner returning id
    `;
    await db`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
        duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment!.id},${serviceId},'Credit Groom',60,${priceMinor})
    `;
    return appointment!.id;
  }

  /** A completed appointment turned into an open invoice. Returns the invoice id. */
  async function openInvoice(
    priceMinor = 5_000, client?: { customerId: string; petId: string }
  ): Promise<string> {
    const appointmentId = await completedAppointment(priceMinor, client);
    const response = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
      headers: { cookie: ownerCookie, "idempotency-key": key() },
      payload: { discountMinor: 0, tipMinor: 0, appliedDiscountIds: [] }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function grant(
    amountMinor: number, reason: string,
    options: { customerId?: string; session?: string; kind?: string; correctsEntryId?: string;
      requestKey?: string } = {}
  ) {
    return app.inject({
      method: "POST",
      url: `/api/customers/${options.customerId ?? customerId}/credit`,
      headers: { cookie: options.session ?? ownerCookie, "idempotency-key": options.requestKey ?? key() },
      payload: {
        kind: options.kind ?? "grant", amountMinor, reason,
        ...(options.correctsEntryId ? { correctsEntryId: options.correctsEntryId } : {})
      }
    });
  }

  async function pay(
    invoiceId: string, amountMinor: number, expectedBalanceMinor: number,
    options: { method?: string; session?: string; requestKey?: string } = {}
  ) {
    return app.inject({
      method: "POST", url: `/api/invoices/${invoiceId}/payments`,
      headers: { cookie: options.session ?? ownerCookie, "idempotency-key": options.requestKey ?? key() },
      payload: {
        amountMinor, expectedBalanceMinor, method: options.method ?? "client_credit"
      }
    });
  }

  async function voidPayment(paymentId: string, reason = "Keyed the wrong amount", session?: string) {
    return app.inject({
      method: "POST", url: `/api/payments/${paymentId}/void`,
      headers: { cookie: session ?? ownerCookie, "idempotency-key": key() },
      payload: { reason }
    });
  }

  async function credit(
    options: { customerId?: string; session?: string } = {}
  ): Promise<CreditRead> {
    const response = await app.inject({
      method: "GET",
      url: `/api/customers/${options.customerId ?? customerId}/credit`,
      headers: { cookie: options.session ?? ownerCookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  /** The balance straight from the table, so a reported figure is never checked against itself. */
  async function ledgerSum(who = customerId): Promise<number> {
    const [row] = await db<{ total: number }[]>`
      select coalesce(sum(amount_minor),0)::int as total from customer_credit_entries
      where business_id=${businessId} and customer_id=${who}
    `;
    return row?.total ?? 0;
  }

  async function receipt(invoiceId: string) {
    const response = await app.inject({
      method: "GET", url: `/api/invoices/${invoiceId}/receipt`, headers: { cookie: ownerCookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `salon-credit-${suffix}@example.test`,
        password: "correct horse salon credit", businessName: "Credit Salon"
      }
    });
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());
    const rival = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `rival-credit-${suffix}@example.test`,
        password: "correct horse rival credit", businessName: "Rival Credit"
      }
    });
    rivalCookie = cookie(rival);

    // No tax, so every assertion is about the credit and not about the rounding of a rate.
    await app.inject({
      method: "PUT", url: "/api/business/settings", headers: { cookie: ownerCookie },
      payload: {
        name: "Credit Salon", timezone: "America/Los_Angeles", currency: "USD",
        taxRateBasisPoints: 0, reminderLeadMinutes: 1440, locationVersion: 1
      }
    });
    serviceId = (await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name: "Credit Groom", baseDurationMinutes: 60, basePriceMinor: 5_000 }
    })).json().id;
    employeeId = (await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: "Credit Groomer", serviceIds: [serviceId] }
    })).json().id;
    ({ customerId, petId } = await newClient("Cred", "Holder"));

    // A cashier who may take payments and honour credit, but may not create it.
    receptionistCookie = await seatMember("credit-receptionist", [
      "customers.view", "appointments.view", "checkout.perform", "payments.view"
    ]);
    // Somebody who may grant credit but may NOT see money. The order must be enforced server side.
    granterBlindCookie = await seatMember("credit-blind-granter", [
      "customers.view", "customers.credit_edit"
    ]);
    // Somebody who may look at the client but not at money at all.
    viewerCookie = await seatMember("credit-viewer", ["customers.view", "appointments.view"]);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end({ timeout: 5 });
  });

  // -------------------------------------------------------------------------------------------
  // The ledger itself.
  // -------------------------------------------------------------------------------------------

  it("reports a client with no ledger as zero rather than as missing", async () => {
    const fresh = await newClient("Empty", "Ledger");
    const view = await credit({ customerId: fresh.customerId });
    expect(view).toMatchObject({
      balanceMinor: 0, grantedMinor: 0, usedMinor: 0, entryCount: 0, entryTotal: 0
    });
    expect(view.entries).toEqual([]);
    // `usedMinor` must be a true zero. Unary negation of nothing produces `-0` in JavaScript, and
    // a client reading the sign bit would render "-$0.00" for a client who has spent nothing.
    expect(Object.is(view.usedMinor, -0)).toBe(false);
    expect(view.entryKinds.map((kind) => kind.value)).toEqual([
      "grant", "adjustment", "redemption", "redemption_reversal"
    ]);
  });

  it("refuses to update or delete a ledger row", async () => {
    const client = await newClient("Immutable", "Ledger");
    const created = await grant(2_500, "Goodwill", { customerId: client.customerId });
    expect(created.statusCode).toBe(201);
    const entryId = created.json().id as string;

    // A ledger whose rows can be edited is a table with extra steps: the balance is the sum of
    // what happened, so anything that could rewrite a row could rewrite the balance silently.
    await expect(db`
      update customer_credit_entries set amount_minor=999999 where id=${entryId}
    `).rejects.toThrow(/immutable/);
    await expect(db`
      delete from customer_credit_entries where id=${entryId}
    `).rejects.toThrow(/immutable/);
    // Even the reason, which looks harmless, is refused - it is the row a dispute lands on.
    await expect(db`
      update customer_credit_entries set reason='Something else' where id=${entryId}
    `).rejects.toThrow(/immutable/);
    expect(await ledgerSum(client.customerId)).toBe(2_500);
  });

  it("refuses an entry whose sign does not match its kind", async () => {
    const client = await newClient("Signed", "Entry");
    // The API refuses a negative grant before the database is reached...
    const negativeGrant = await grant(-500, "Should not be a grant", { customerId: client.customerId });
    expect(negativeGrant.statusCode).toBe(400);
    // ...and the database refuses it too, which is what makes it a rule rather than a form check.
    await expect(db`
      insert into customer_credit_entries(business_id,customer_id,kind,amount_minor,reason)
      values (${businessId},${client.customerId},'grant',-500,'Impossible')
    `).rejects.toThrow(/credit_entry_sign_matches_kind/);
    // A redemption that ADDS to a balance is likewise not representable.
    await expect(db`
      insert into customer_credit_entries(business_id,customer_id,kind,amount_minor)
      values (${businessId},${client.customerId},'redemption',500)
    `).rejects.toThrow(/credit_entry_sign_matches_kind/);
    // And an entry that moves nothing says nothing. Two constraints refuse it - the column's own
    // `<> 0` and the sign rule - and the sign rule is the one that fires, because it is the
    // stricter statement of the same fact.
    await expect(db`
      insert into customer_credit_entries(business_id,customer_id,kind,amount_minor,reason)
      values (${businessId},${client.customerId},'adjustment',0,'Nothing')
    `).rejects.toThrow(/credit_entry_sign_matches_kind/);
  });

  it("requires a reason for a deduction as firmly as for a grant", async () => {
    const client = await newClient("Reasoned", "Entry");
    await grant(5_000, "Opening balance", { customerId: client.customerId });
    const blank = await app.inject({
      method: "POST", url: `/api/customers/${client.customerId}/credit`,
      headers: { cookie: ownerCookie, "idempotency-key": key() },
      payload: { kind: "adjustment", amountMinor: -1_000, reason: "   " }
    });
    expect(blank.statusCode).toBe(400);
    // The database says the same thing, for both staff kinds. A deduction is more contestable
    // than a grant, so this is the entry that most needs an explanation attached.
    await expect(db`
      insert into customer_credit_entries(business_id,customer_id,kind,amount_minor)
      values (${businessId},${client.customerId},'adjustment',-1_000)
    `).rejects.toThrow(/credit_entry_reason_required/);
    expect(await ledgerSum(client.customerId)).toBe(5_000);
  });

  it("corrects a mistake with a compensating entry and pairs the two rows", async () => {
    const client = await newClient("Corrected", "Grant");
    const mistake = (await grant(10_000, "Meant to be $10, not $100", {
      customerId: client.customerId
    })).json().id as string;
    const fix = await grant(-9_000, "Correcting the decimal point", {
      customerId: client.customerId, kind: "adjustment", correctsEntryId: mistake
    });
    expect(fix.statusCode, fix.body).toBe(201);

    const view = await credit({ customerId: client.customerId });
    expect(view.balanceMinor).toBe(1_000);
    const [correction, corrected] = view.entries;
    // Newest first, and BOTH rows carry the link, so either can render its sentence without a
    // second fetch: the correction names what it corrects, the corrected row knows it was fixed.
    expect(correction?.correctsEntryId).toBe(mistake);
    expect(corrected?.id).toBe(mistake);
    expect(corrected?.correctedAt).not.toBeNull();
    expect(correction?.pairId).toBe(corrected?.pairId);
    // A grant may not claim to be a correction; only an adjustment compensates.
    const badKind = await grant(100, "Not a correction", {
      customerId: client.customerId, correctsEntryId: mistake
    });
    expect(badKind.statusCode).toBe(400);
    // And a correction may not reach across clients within the same salon, which no foreign key
    // stops on its own: the composite key on `(business_id, corrects_entry_id)` blocks another
    // TENANT's row, and nothing in the schema blocks another client's within this one.
    //
    // The stranger is given a balance first, so this is refused by the correction check and not
    // incidentally by the overdraft check - a test that passes for the wrong reason would not
    // notice the guard being removed.
    const stranger = await newClient("Other", "Client");
    await grant(5_000, "So the deduction is affordable", { customerId: stranger.customerId });
    const crossClient = await grant(-100, "Wrong ledger", {
      customerId: stranger.customerId, kind: "adjustment", correctsEntryId: mistake
    });
    expect(crossClient.statusCode).toBe(404);
    expect(crossClient.json().code).toBe("CREDIT_ENTRY_NOT_FOUND");
  });

  it("computes the running balance on the server, on every page", async () => {
    const client = await newClient("Running", "Balance");
    for (let index = 0; index < 12; index += 1) {
      const response = await grant(100 * (index + 1), `Grant ${index + 1}`, {
        customerId: client.customerId
      });
      expect(response.statusCode).toBe(201);
    }
    const total = await ledgerSum(client.customerId);
    const firstPage = await app.inject({
      method: "GET",
      url: `/api/customers/${client.customerId}/credit/entries?page=1&pageSize=10`,
      headers: { cookie: ownerCookie }
    });
    expect(firstPage.statusCode).toBe(200);
    const first = firstPage.json();
    expect(first.total).toBe(12);
    expect(first.items).toHaveLength(10);
    // Newest first, so the first row's running balance is the whole balance.
    expect(first.items[0].balanceAfterMinor).toBe(total);

    const secondPage = (await app.inject({
      method: "GET",
      url: `/api/customers/${client.customerId}/credit/entries?page=2&pageSize=10`,
      headers: { cookie: ownerCookie }
    })).json();
    expect(secondPage.items).toHaveLength(2);
    // THE POINT OF COMPUTING IT SERVER SIDE. Page two's figures are what page one would have
    // shown for those rows: a browser accumulating only the rows it was sent could not know what
    // came before them, and its running balance would restart at zero here.
    expect(secondPage.items[1].balanceAfterMinor).toBe(100);
    expect(secondPage.items[0].balanceAfterMinor).toBe(300);
  });

  // -------------------------------------------------------------------------------------------
  // Spending it.
  // -------------------------------------------------------------------------------------------

  it("settles an invoice from credit exactly as cash would", async () => {
    const client = await newClient("Settled", "ByCredit");
    await grant(5_000, "Opening balance", { customerId: client.customerId });
    const creditInvoice = await openInvoice(5_000, client);
    const cashInvoice = await openInvoice(5_000, client);

    const paid = await pay(creditInvoice, 5_000, 5_000);
    expect(paid.statusCode, paid.body).toBe(201);
    expect(paid.json().balance).toBe(0);
    expect(paid.json().creditRemainingMinor).toBe(0);

    const cash = await pay(cashInvoice, 5_000, 5_000, { method: "cash" });
    expect(cash.statusCode).toBe(201);
    // `applyInvoiceSettlement` sums recorded payments without looking at the method, so a credit
    // payment and a cash payment must leave an invoice in the identical state. Anything else would
    // mean credit settled invoices differently from money, which nothing downstream expects.
    const byCredit = await receipt(creditInvoice);
    const byCash = await receipt(cashInvoice);
    expect(byCredit.invoice.status).toBe("paid");
    expect(byCredit.invoice.status).toBe(byCash.invoice.status);
    expect(byCredit.invoice.balanceMinor).toBe(byCash.invoice.balanceMinor);
    expect(byCredit.payments[0].method).toBe("client_credit");

    const view = await credit({ customerId: client.customerId });
    expect(view).toMatchObject({ balanceMinor: 0, grantedMinor: 5_000, usedMinor: 5_000 });
    // The redemption line carries the invoice it settled, so the ledger reads without a join.
    const redemption = view.entries.find((entry) => entry.kind === "redemption");
    expect(redemption?.invoiceId).toBe(creditInvoice);
    expect(redemption?.invoiceNumber).toBe(byCredit.invoice.invoiceNumber);
    expect(redemption?.amountMinor).toBe(-5_000);
  });

  it("refuses a redemption larger than the balance", async () => {
    const client = await newClient("Overdrawn", "Client");
    await grant(2_000, "Small balance", { customerId: client.customerId });
    const invoice = await openInvoice(5_000, client);
    const response = await pay(invoice, 5_000, 5_000, {});
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("CREDIT_BALANCE_INSUFFICIENT");
    expect(await ledgerSum(client.customerId)).toBe(2_000);
    // The invoice is untouched: no payment, no partial settlement.
    expect((await receipt(invoice)).payments).toHaveLength(0);
  });

  it("refuses a deduction that would take the balance below zero", async () => {
    const client = await newClient("Negative", "Balance");
    await grant(3_000, "Opening balance", { customerId: client.customerId });
    const response = await grant(-4_000, "Too much", {
      customerId: client.customerId, kind: "adjustment"
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("CREDIT_BALANCE_INSUFFICIENT");
    // A NEGATIVE BALANCE WOULD BE A DEBT, and Pawsh already represents debt as an invoice with an
    // outstanding balance. Two representations of the same money is the bug, so this is refused
    // rather than stored.
    expect(await ledgerSum(client.customerId)).toBe(3_000);
    // Exactly to zero is fine - that is a balance being cleared, not a debt being created.
    const toZero = await grant(-3_000, "Clearing the account", {
      customerId: client.customerId, kind: "adjustment"
    });
    expect(toZero.statusCode).toBe(201);
    expect(await ledgerSum(client.customerId)).toBe(0);
  });

  /**
   * THE TEST THAT JUSTIFIES THE WHOLE DESIGN.
   *
   * No check constraint and no unique index can enforce "the redemptions may not exceed the
   * grants" - that is a statement about an aggregate, and a constraint sees one row. The only
   * thing standing between a $50 balance and $100 of spending is
   * `select ... from customers ... for update`, so it is raced here rather than reasoned about.
   */
  it("lets two concurrent redemptions of one balance spend it exactly once", async () => {
    const client = await newClient("Raced", "Balance");
    await grant(5_000, "One balance, two tills", { customerId: client.customerId });
    const first = await openInvoice(5_000, client);
    const second = await openInvoice(5_000, client);

    const [one, two] = await Promise.all([
      pay(first, 5_000, 5_000),
      pay(second, 5_000, 5_000)
    ]);
    const codes = [one.statusCode, two.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const refused = one.statusCode === 409 ? one : two;
    expect(refused.json().code).toBe("CREDIT_BALANCE_INSUFFICIENT");

    // EXACTLY $50 SPENT. Not $100, and not $50 with a second redemption row that settled nothing.
    expect(await ledgerSum(client.customerId)).toBe(0);
    const view = await credit({ customerId: client.customerId });
    expect(view).toMatchObject({ balanceMinor: 0, grantedMinor: 5_000, usedMinor: 5_000 });
    const [redemptions] = await db<{ count: number }[]>`
      select count(*)::int as count from customer_credit_entries
      where business_id=${businessId} and customer_id=${client.customerId} and kind='redemption'
    `;
    expect(redemptions?.count).toBe(1);
    // And exactly one invoice was settled; the other is still collectable.
    const settled = [await receipt(first), await receipt(second)]
      .filter((row) => row.invoice.status === "paid");
    expect(settled).toHaveLength(1);
  });

  // -------------------------------------------------------------------------------------------
  // Giving it back.
  // -------------------------------------------------------------------------------------------

  it("returns the exact amount to the balance when a credit payment is voided", async () => {
    const client = await newClient("Voided", "Redemption");
    await grant(5_000, "Opening balance", { customerId: client.customerId });
    const invoice = await openInvoice(3_000, client);
    const paymentId = (await pay(invoice, 3_000, 3_000)).json().id as string;
    expect(await ledgerSum(client.customerId)).toBe(2_000);

    const voided = await voidPayment(paymentId, "Wrong client");
    expect(voided.statusCode, voided.body).toBe(200);

    // REVERSAL HAS EXACTLY ONE DESTINATION. The money never touched a card, so it cannot go back
    // to one; the only truthful place for it is the balance it came off.
    expect(await ledgerSum(client.customerId)).toBe(5_000);
    const view = await credit({ customerId: client.customerId });
    expect(view).toMatchObject({ balanceMinor: 5_000, grantedMinor: 5_000, usedMinor: 0 });
    // `usedMinor` NET OF REVERSALS is what keeps `granted - used = balance` true on screen.
    expect(view.grantedMinor - view.usedMinor).toBe(view.balanceMinor);

    const reversal = view.entries.find((entry) => entry.kind === "redemption_reversal");
    const redemption = view.entries.find((entry) => entry.kind === "redemption");
    expect(reversal?.amountMinor).toBe(3_000);
    expect(reversal?.reason).toBe("Wrong client");
    // Both rows of the pair render without a second fetch.
    expect(reversal?.reversesEntryId).toBe(redemption?.id);
    expect(redemption?.reversedAt).not.toBeNull();
    expect(reversal?.pairId).toBe(paymentId);
    expect(redemption?.pairId).toBe(paymentId);
    // The invoice is collectable again, exactly as voiding a cash payment leaves it.
    expect((await receipt(invoice)).invoice.status).toBe("open");
  });

  it("refuses a second void twice over, independently", async () => {
    const client = await newClient("Twice", "Voided");
    await grant(4_000, "Opening balance", { customerId: client.customerId });
    const invoice = await openInvoice(4_000, client);
    const paymentId = (await pay(invoice, 4_000, 4_000)).json().id as string;
    expect((await voidPayment(paymentId)).statusCode).toBe(200);

    // FIRST DEFENCE: the handler's own status check.
    const second = await voidPayment(paymentId, "Trying again");
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("PAYMENT_ALREADY_VOIDED");

    // SECOND DEFENCE, INDEPENDENT OF THE FIRST: the partial unique index. This inserts the row
    // the handler would have written, bypassing the status check entirely, and the database
    // refuses it. The two are not redundant - one is logic in a handler, the other is a fact
    // about the table - and a double reversal would hand the client money twice.
    await expect(db`
      insert into customer_credit_entries
        (business_id,customer_id,kind,amount_minor,invoice_id,payment_id)
      values (${businessId},${client.customerId},'redemption_reversal',4_000,${invoice},${paymentId})
    `).rejects.toThrow(/customer_credit_reversal_per_payment/);

    // The redemption side is protected the same way: one payment is spent once.
    await expect(db`
      insert into customer_credit_entries
        (business_id,customer_id,kind,amount_minor,invoice_id,payment_id)
      values (${businessId},${client.customerId},'redemption',-4_000,${invoice},${paymentId})
    `).rejects.toThrow(/customer_credit_redemption_per_payment/);

    expect(await ledgerSum(client.customerId)).toBe(4_000);
  });

  it("lets credit be re-applied to an invoice after a mistaken void", async () => {
    // The reason the redemption index is keyed on the PAYMENT and not on the invoice. An operator
    // who applies $50, voids it because the client wanted $20, and re-applies $20 must not be
    // refused by the database with no way forward.
    const client = await newClient("Reapplied", "Credit");
    await grant(5_000, "Opening balance", { customerId: client.customerId });
    const invoice = await openInvoice(5_000, client);
    const firstPaymentId = (await pay(invoice, 5_000, 5_000)).json().id as string;
    expect((await voidPayment(firstPaymentId, "Client wanted less on credit")).statusCode).toBe(200);

    const second = await pay(invoice, 2_000, 5_000);
    expect(second.statusCode, second.body).toBe(201);
    expect(await ledgerSum(client.customerId)).toBe(3_000);
    expect((await receipt(invoice)).invoice.status).toBe("partially_paid");
  });

  it("keeps the ledger sum equal to the reported balance through an arbitrary sequence", async () => {
    const client = await newClient("Arbitrary", "Sequence");
    await grant(10_000, "Opening balance", { customerId: client.customerId });
    await grant(-1_500, "Correcting an over-grant", {
      customerId: client.customerId, kind: "adjustment"
    });
    const firstInvoice = await openInvoice(3_000, client);
    const firstPayment = (await pay(firstInvoice, 3_000, 3_000)).json().id as string;
    await grant(2_000, "Service recovery", { customerId: client.customerId });
    const secondInvoice = await openInvoice(4_000, client);
    await pay(secondInvoice, 4_000, 4_000);
    await voidPayment(firstPayment, "Charged the wrong visit");
    await grant(250, "Rounding goodwill", { customerId: client.customerId });

    const expected = 10_000 - 1_500 - 3_000 + 2_000 - 4_000 + 3_000 + 250;
    expect(await ledgerSum(client.customerId)).toBe(expected);
    const view = await credit({ customerId: client.customerId });
    expect(view.balanceMinor).toBe(expected);
    expect(view.grantedMinor - view.usedMinor).toBe(view.balanceMinor);
    expect(view.grantedMinor).toBe(10_000 - 1_500 + 2_000 + 250);
    expect(view.usedMinor).toBe(4_000);
    // Seven rows: grant, adjustment, redemption, grant, redemption, reversal, grant. The void
    // ADDS a row rather than removing one, which is the append-only property in a single number.
    expect(view.entryTotal).toBe(7);
    // The running balance on the newest row is the balance, which is the same number three
    // different code paths just produced.
    expect(view.entries[0]?.balanceAfterMinor).toBe(expected);
  });

  // -------------------------------------------------------------------------------------------
  // Replay, permissions, isolation.
  // -------------------------------------------------------------------------------------------

  it("creates exactly one entry when a grant is replayed", async () => {
    const client = await newClient("Replayed", "Grant");
    const requestKey = key();
    const first = await grant(2_500, "Double-tapped button", {
      customerId: client.customerId, requestKey
    });
    expect(first.statusCode).toBe(201);
    const second = await grant(2_500, "Double-tapped button", {
      customerId: client.customerId, requestKey
    });
    // The replay is ANSWERED WITH THE FIRST RESULT, not honoured a second time. `credit.adjust`
    // had to be added to `financial_idempotency_requests.operation` for this to work at all - an
    // un-widened check fails at runtime, not at build.
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(await ledgerSum(client.customerId)).toBe(2_500);
    const [entries] = await db<{ count: number }[]>`
      select count(*)::int as count from customer_credit_entries
      where business_id=${businessId} and customer_id=${client.customerId}
    `;
    expect(entries?.count).toBe(1);
    // A different amount under the same key is a different request and is refused.
    const conflicting = await grant(9_999, "Double-tapped button", {
      customerId: client.customerId, requestKey
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("lets a receptionist apply credit but not create it", async () => {
    const client = await newClient("Receptionist", "Served");
    await grant(4_000, "Owner-granted balance", { customerId: client.customerId });
    const invoice = await openInvoice(4_000, client);

    // APPLYING needs only `checkout.perform`, exactly as redeeming a coupon does. The operator is
    // honouring something the client was already given, not deciding anything.
    const applied = await pay(invoice, 4_000, 4_000, { session: receptionistCookie });
    expect(applied.statusCode, applied.body).toBe(201);
    expect(await ledgerSum(client.customerId)).toBe(0);

    // GRANTING needs `customers.credit_edit`, which this role does not hold. A receptionist who
    // could invent credit could hand the salon's money to anybody.
    const granted = await grant(4_000, "Making some up", {
      customerId: client.customerId, session: receptionistCookie
    });
    expect(granted.statusCode).toBe(403);
    expect(granted.json().error).toContain("customers.credit_edit");
    // And the read is offered, because this role does hold `payments.view`.
    const view = await credit({ customerId: client.customerId, session: receptionistCookie });
    expect(view.canEdit).toBe(false);
    expect(view.balanceMinor).toBe(0);
  });

  it("does not let credit_edit override payments.view", async () => {
    const client = await newClient("Blind", "Granter");
    // GRANTING AGAINST A BALANCE YOU CANNOT SEE is worse than not granting at all: the grant lands
    // on a number the granter had no way to check. The order is enforced on the server, not left
    // to whoever configures the role.
    const granted = await grant(1_000, "Cannot see the balance", {
      customerId: client.customerId, session: granterBlindCookie
    });
    expect(granted.statusCode).toBe(403);
    expect(granted.json().error).toContain("payments.view");
    expect(await ledgerSum(client.customerId)).toBe(0);

    const read = await app.inject({
      method: "GET", url: `/api/customers/${client.customerId}/credit`,
      headers: { cookie: granterBlindCookie }
    });
    expect(read.statusCode).toBe(403);
  });

  it("withholds the balance from a viewer without payments.view rather than zeroing it", async () => {
    const client = await newClient("Withheld", "Figure");
    await grant(7_500, "Visible to the owner only", { customerId: client.customerId });

    const denied = await app.inject({
      method: "GET", url: `/api/customers/${client.customerId}/credit`,
      headers: { cookie: viewerCookie }
    });
    expect(denied.statusCode).toBe(403);

    // ABSENT, NOT ZERO. A zero balance is a normal state, so a zero shown in place of a withheld
    // figure is indistinguishable from the truth - which is exactly why the profile read returns a
    // null summary rather than an emptied one.
    const profile = await app.inject({
      method: "GET", url: `/api/customers/${client.customerId}/history`,
      headers: { cookie: viewerCookie }
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().summary).toBeNull();
    expect(JSON.stringify(profile.json())).not.toContain("7500");

    const owner = await app.inject({
      method: "GET", url: `/api/customers/${client.customerId}/history`,
      headers: { cookie: ownerCookie }
    });
    expect(owner.json().summary.credit).toMatchObject({
      balanceMinor: 7_500, grantedMinor: 7_500, usedMinor: 0, entryCount: 1, entryTotal: 1
    });
  });

  it("offers the balance to a checkout operator through the checkout payload", async () => {
    const client = await newClient("Checkout", "Payload");
    await grant(6_000, "Opening balance", { customerId: client.customerId });
    const options = await app.inject({
      method: "GET", url: `/api/checkout/payment-options?customerId=${client.customerId}`,
      headers: { cookie: receptionistCookie }
    });
    expect(options.statusCode).toBe(200);
    // A DELIBERATE NARROW EXPOSURE of one money figure to a role that may lack `payments.view`. It
    // follows from applying credit needing only `checkout.perform`: an operator who may spend a
    // balance has to be told what it is.
    expect(options.json().creditAvailableMinor).toBe(6_000);

    // NULL, NOT ZERO, when no client is named - "nobody was asked about" is not "this client has
    // nothing", and a caller that could not tell them apart would render an empty credit line on
    // a request that never mentioned a customer.
    const anonymous = await app.inject({
      method: "GET", url: "/api/checkout/payment-options", headers: { cookie: receptionistCookie }
    });
    expect(anonymous.json().creditAvailableMinor).toBeNull();
  });

  it("keeps one salon's credit invisible and unreachable from another", async () => {
    const client = await newClient("Tenant", "Isolated");
    await grant(3_300, "Ours alone", { customerId: client.customerId });
    for (const url of [
      `/api/customers/${client.customerId}/credit`,
      `/api/customers/${client.customerId}/credit/entries`
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { cookie: rivalCookie } });
      expect(response.statusCode, url).toBe(404);
    }
    const write = await grant(1_000, "Not theirs to give", {
      customerId: client.customerId, session: rivalCookie
    });
    expect(write.statusCode).toBe(404);
    expect(await ledgerSum(client.customerId)).toBe(3_300);
  });

  it("reports credit as its own settlement row without breaking the revenue invariant", async () => {
    const client = await newClient("Reported", "Credit");
    await grant(5_000, "Opening balance", { customerId: client.customerId });
    const creditInvoice = await openInvoice(5_000, client);
    const cashInvoice = await openInvoice(5_000, client);
    expect((await pay(creditInvoice, 5_000, 5_000)).statusCode).toBe(201);
    expect((await pay(cashInvoice, 5_000, 5_000, { method: "cash" })).statusCode).toBe(201);

    const from = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const response = await app.inject({
      method: "GET", url: `/api/reports?localDate=${from}&days=31`, headers: { cookie: ownerCookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json();
    const methods: { method: string; amountMinor: number }[] = report.paymentMethods;

    // CREDIT GETS ITS OWN ROW FOR FREE, because the report already groups by method - which is the
    // whole reason it is not modelled as `other`. A salon that cannot separate cash collected from
    // credit honoured cannot reconcile a till.
    const creditRow = methods.find((row) => row.method === "client_credit");
    expect(creditRow).toBeDefined();
    expect(creditRow!.amountMinor).toBeGreaterThanOrEqual(5_000);

    // THE DOCUMENTED INVARIANT STILL HOLDS. `paidRevenueMinor` now includes money that was not
    // collected in this period, which is correct and is the stated consequence of credit settling
    // an invoice like any other payment - both sides of this equality count the same recorded
    // payments, so the identity is untouched.
    const summed = methods.reduce((total, row) => total + Number(row.amountMinor), 0);
    expect(summed).toBe(report.totals.paidRevenueMinor);
  });

  it("reports customers.credit_edit as an enforced permission now that it gates a route", async () => {
    const catalog = await app.inject({
      method: "GET", url: "/api/permissions", headers: { cookie: ownerCookie }
    });
    expect(catalog.statusCode).toBe(200);
    const rows: { key: string; enforced: boolean }[] = catalog.json().groups
      .flatMap((group: { permissions: { key: string; enforced: boolean }[] }) => group.permissions);

    // `unenforcedPermissions` drives `enforced: false`, which the role editor renders as "Not yet
    // available in Pawsh". Leaving this key on that list now that it refuses people would tell an
    // owner a switch does nothing while it is in fact gating money - the same class of mistake the
    // list exists to prevent, pointed the other way. It graduated, after `settings.discounts`.
    expect(rows.find((row) => row.key === "customers.credit_edit")?.enforced).toBe(true);

    // SPENDING credit graduated nothing, because it needs no key of its own: `checkout.perform`
    // already gates it, exactly as it gates redeeming a coupon.
    expect(rows.find((row) => row.key === "checkout.perform")?.enforced).toBe(true);

    // And gift cards are still a non-goal, so their switches still gate nothing.
    expect(rows.find((row) => row.key === "gift_cards.sell")?.enforced).toBe(false);
    expect(rows.find((row) => row.key === "settings.gift_cards")?.enforced).toBe(false);
  });

  it("refuses client_credit as a configurable settlement type", async () => {
    // A configurable "Store credit" tile would let an operator settle an invoice through the
    // ordinary method picker without ever debiting the ledger - money spent from a balance that
    // never moved. The API refuses it...
    const response = await app.inject({
      method: "POST", url: "/api/settings/payment-methods", headers: { cookie: ownerCookie },
      payload: { name: "Store credit", settlementType: "client_credit", enabled: true }
    });
    expect(response.statusCode).toBe(400);
    // ...the settings payload never offers it...
    const settings = await app.inject({
      method: "GET", url: "/api/settings/tax-payments", headers: { cookie: ownerCookie }
    });
    expect(settings.json().settlementTypes.map((type: { value: string }) => type.value))
      .not.toContain("client_credit");
    // ...and migration 0034's check, deliberately left unwidened by 0048, refuses it underneath.
    await expect(db`
      insert into payment_methods(business_id,name,settlement_type,sort_order)
      values (${businessId},'Sneaky credit','client_credit',99)
    `).rejects.toThrow(/settlement_type/);
  });
});
