import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDiscounts, calculateInvoice, permissionPresets } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { roleFor } from "../support/roles.js";

/**
 * SERVICES ARE EDITABLE UNTIL ANY PAYMENT IS RECORDED.
 *
 * Both service writes - `PUT /api/appointments/:id/services` and
 * `PATCH /api/appointments/:id/services/:lineId` - accept scheduled, checked-in, in-service and
 * completed visits. An invoice no longer locks them; a recorded payment does, client credit
 * included, and voiding it unlocks them again. While the invoice is unpaid, the edit recomputes
 * that same invoice from the new lines with checkout's arithmetic, in the same transaction.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "services-until-payment-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

interface InvoiceRow {
  id: string; invoiceNumber: string; status: string; subtotalMinor: number; discountMinor: number;
  taxMinor: number; tipMinor: number; totalMinor: number; balanceMinor: number;
  calculationVersion: number; taxRateBasisPoints: number;
}

describeDatabase("appointment services are editable until a payment is recorded", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  const taxRateBasisPoints = 825;

  let ownerCookie = "";
  let businessId = "";
  let locationId = "";
  let customerId = "";
  let petId = "";
  let groomId = "";
  let bathId = "";
  let nailsId = "";
  let tenPercent = "";
  let employeeA = "";
  let employeeB = "";
  let groomerA = "";

  const key = () => crypto.randomUUID();
  let bookingDay = 0;
  const nextDay = () => {
    bookingDay += 1;
    const month = bookingDay > 28 ? "07" : "06";
    const day = bookingDay > 28 ? bookingDay - 28 : bookingDay;
    return `2036-${month}-${String(day).padStart(2, "0")}`;
  };

  const request = (method: "GET" | "POST" | "PATCH" | "PUT", url: string,
    sessionCookie: string, payload?: Record<string, unknown>) =>
    app.inject({
      method, url, headers: { cookie: sessionCookie, "idempotency-key": key() },
      ...(payload ? { payload } : {})
    });

  async function seat(label: string, permissions: readonly string[]) {
    const email = `until-paid-${label}-${suffix}@example.test`;
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

  async function employeeFor(displayName: string, membershipId: string): Promise<string> {
    const response = await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName, serviceIds: [groomId, bathId, nailsId], membershipId }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function book(employeeId: string, serviceIds: string[]) {
    const response = await request("POST", "/api/appointments", ownerCookie, {
      locationId, customerId, petId, employeeId, serviceIds,
      localStart: `${nextDay()}T09:00`, expectedLocationVersion: 1
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  const transition = async (id: string, status: string) => {
    const response = await request("POST", `/api/appointments/${id}/transition`, ownerCookie, { status });
    expect(response.statusCode, response.body).toBe(200);
  };

  const checkoutBody = (extra: Record<string, unknown> = {}) =>
    ({ discountMinor: 0, tipMinor: 500, appliedDiscountIds: [tenPercent], ...extra });

  /** Booked with a groom, taken to `completed`, and checked out with 10% off and a $5 tip. */
  async function invoicedVisit(employeeId = employeeA, extra: Record<string, unknown> = {}) {
    const id = await book(employeeId, [groomId]);
    await transition(id, "checked_in");
    await transition(id, "completed");
    const checkout = await request("POST", `/api/appointments/${id}/checkout`, ownerCookie, checkoutBody(extra));
    expect(checkout.statusCode, checkout.body).toBe(201);
    return { id, invoiceId: checkout.json().id as string };
  }

  const detail = async (id: string) => {
    const response = await request("GET", `/api/appointments/${id}`, ownerCookie);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as {
      version: number; servicesEditable: boolean; invoiceId: string | null;
      services: { id: string; serviceId: string; priceMinor: number }[];
    };
  };

  const invoice = async (id: string) => {
    const [row] = await db<InvoiceRow[]>`
      select id,invoice_number,status,subtotal_minor,discount_minor,tax_minor,tip_minor,total_minor,
        balance_minor,calculation_version,tax_rate_basis_points
      from invoices where business_id=${businessId} and id=${id}
    `;
    return row!;
  };

  const invoiceItems = (id: string) => db<{ description: string; amountMinor: number; linePosition: number }[]>`
    select description,amount_minor,line_position from invoice_items
    where business_id=${businessId} and invoice_id=${id} order by line_position
  `;

  const recalculations = (id: string) => db<{ beforeData: Record<string, number | string>; afterData: Record<string, number | string> }[]>`
    select before_data,after_data from audit_events
    where business_id=${businessId} and resource_type='invoice' and resource_id=${id} and action='invoice.recalculate'
    order by created_at,id
  `;

  /** What checkout's authority says this bill is, for a percentage discount and the invoice's tip. */
  const expectedTotals = (lineAmounts: number[], tipMinor: number) => {
    const subtotal = lineAmounts.reduce((sum, amount) => sum + amount, 0);
    const application = applyDiscounts({
      subtotal, lines: [{ kind: "percentage", rateBasisPoints: 1000 }], stackingMode: "one_per_appointment"
    });
    return calculateInvoice({ lineAmounts, discount: application.discountMinor, taxRateBasisPoints, tip: tipMinor });
  };

  const pay = (invoiceId: string, amountMinor: number, expectedBalanceMinor: number, method: string) =>
    request("POST", `/api/invoices/${invoiceId}/payments`, ownerCookie, { amountMinor, expectedBalanceMinor, method });

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: `until-paid-owner-${suffix}@example.test`, password: "correct horse until paid", businessName: "Until Paid Salon" }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());
    await db`update businesses set tax_rate_basis_points=${taxRateBasisPoints} where id=${businessId}`;

    const service = async (name: string, baseDurationMinutes: number, basePriceMinor: number) => {
      const response = await app.inject({
        method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
        payload: { name, baseDurationMinutes, basePriceMinor }
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().id as string;
    };
    groomId = await service("Until Paid Groom", 60, 8000);
    bathId = await service("Until Paid Bath", 30, 4000);
    nailsId = await service("Until Paid Nails", 15, 1500);

    const discount = await app.inject({
      method: "POST", url: "/api/settings/discounts", headers: { cookie: ownerCookie },
      payload: { name: `Until paid ten percent ${suffix}`, kind: "percentage", rateBasisPoints: 1000 }
    });
    expect(discount.statusCode, discount.body).toBe(201);
    tenPercent = discount.json().createdId;

    const customer = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName: "Until", lastName: "Paid", phone: "555-0191" }
    });
    expect(customer.statusCode, customer.body).toBe(201);
    customerId = customer.json().id;
    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Until Paid Pet", species: "dog", breed: "Poodle" }
    });
    expect(pet.statusCode, pet.body).toBe(201);
    petId = pet.json().id;

    const seatA = await seat("groomer-a", permissionPresets.groomer!);
    const seatB = await seat("groomer-b", permissionPresets.groomer!);
    groomerA = seatA.cookie;
    employeeA = await employeeFor("Until Paid A", seatA.membershipId);
    employeeB = await employeeFor("Until Paid B", seatB.membershipId);

    const granted = await request("POST", `/api/customers/${customerId}/credit`, ownerCookie,
      { kind: "grant", amountMinor: 50_000, reason: "Goodwill" });
    expect(granted.statusCode, granted.body).toBe(201);
  }, 90_000);

  afterAll(async () => { await app.close(); await db.end(); });

  it("edits a scheduled visit with no invoice exactly as before", async () => {
    const id = await book(employeeA, [groomId]);
    const before = await detail(id);
    expect(before.servicesEditable).toBe(true);
    const response = await request("PUT", `/api/appointments/${id}/services`, ownerCookie, {
      version: before.version, lines: [{ id: before.services[0]!.id, serviceId: groomId }, { serviceId: bathId }]
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().servicesEditable).toBe(true);
    expect(response.json().invoiceId).toBeNull();
    const [invoices] = await db<{ count: number }[]>`
      select count(*)::int as count from invoices where business_id=${businessId} and appointment_id=${id}
    `;
    expect(invoices!.count).toBe(0);
  });

  it("edits a completed visit with an unpaid invoice and recomputes that same invoice", async () => {
    const { id, invoiceId } = await invoicedVisit();
    const raised = await invoice(invoiceId);
    expect(raised).toMatchObject({ ...pick(expectedTotals([8000], 500)), status: "open", calculationVersion: 1 });

    const before = await detail(id);
    expect(before.servicesEditable).toBe(true);
    const added = await request("PUT", `/api/appointments/${id}/services`, ownerCookie, {
      version: before.version, lines: [{ id: before.services[0]!.id, serviceId: groomId }, { serviceId: bathId }]
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().invoiceId).toBe(invoiceId);

    const afterAdd = await invoice(invoiceId);
    const addTotals = expectedTotals([8000, 4000], 500);
    expect(afterAdd).toMatchObject({
      id: invoiceId, invoiceNumber: raised.invoiceNumber, status: "open", calculationVersion: 2,
      ...pick(addTotals), balanceMinor: addTotals.total
    });
    expect(added.json().invoiceBalanceMinor).toBe(addTotals.total);
    expect((await invoiceItems(invoiceId)).map((item) => [item.description, item.amountMinor, item.linePosition]))
      .toEqual([["Until Paid Groom", 8000, 1], ["Until Paid Bath", 4000, 2]]);
    const [discountRow] = await db<{ appliedMinor: number }[]>`
      select applied_minor from invoice_discounts where business_id=${businessId} and invoice_id=${invoiceId}
    `;
    expect(discountRow!.appliedMinor).toBe(addTotals.discount);

    // The line edit recomputes it too.
    const bath = (await detail(id)).services.find((line) => line.serviceId === bathId)!;
    const repriced = await request("PATCH", `/api/appointments/${id}/services/${bath.id}`, ownerCookie, { priceMinor: 2500 });
    expect(repriced.statusCode, repriced.body).toBe(200);
    const priceTotals = expectedTotals([8000, 2500], 500);
    expect(await invoice(invoiceId)).toMatchObject({ ...pick(priceTotals), balanceMinor: priceTotals.total, calculationVersion: 3 });

    const audit = await recalculations(invoiceId);
    expect(audit).toHaveLength(2);
    expect(audit[0]!.beforeData).toMatchObject({ subtotalMinor: 8000, totalMinor: raised.totalMinor });
    expect(audit[0]!.afterData).toMatchObject({ subtotalMinor: 12000, totalMinor: addTotals.total, balanceMinor: addTotals.total });
    expect(audit[1]!.afterData).toMatchObject({ subtotalMinor: 10500, totalMinor: priceTotals.total });

    // The recomputed bill is the one checkout itself would raise now: the same request answers
    // with this invoice rather than a conflict.
    const again = await request("POST", `/api/appointments/${id}/checkout`, ownerCookie, checkoutBody());
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(invoiceId);

    // The activity feed carries the recalculation to a payments viewer.
    const activity = await request("GET", `/api/appointments/${id}/activity`, ownerCookie);
    expect(activity.statusCode, activity.body).toBe(200);
    const items = activity.json().items as { action: string; totalMinor: number | null }[];
    expect(items.find((item) => item.action === "invoice.recalculate")?.totalMinor).toBe(priceTotals.total);
  });

  it("clamps a fixed coupon to a smaller bill and keeps its one redemption in step", async () => {
    const coupon = await request("POST", "/api/settings/coupons", ownerCookie,
      { code: `UNTIL${suffix.slice(0, 6)}`.toUpperCase(), kind: "amount", amountMinor: 3000 });
    expect(coupon.statusCode, coupon.body).toBe(201);
    const { id, invoiceId } = await invoicedVisit(employeeA,
      { appliedDiscountIds: [], couponCode: `UNTIL${suffix.slice(0, 6)}`.toUpperCase(), tipMinor: 0 });
    const line = (await detail(id)).services[0]!;
    const response = await request("PATCH", `/api/appointments/${id}/services/${line.id}`, ownerCookie, { priceMinor: 2000 });
    expect(response.statusCode, response.body).toBe(200);
    expect(await invoice(invoiceId)).toMatchObject({ subtotalMinor: 2000, discountMinor: 2000, taxMinor: 0, totalMinor: 0, balanceMinor: 0, status: "paid" });
    const [redemption] = await db<{ amountMinor: number; count: number }[]>`
      select max(amount_minor)::int as amount_minor,count(*)::int as count from coupon_redemptions
      where business_id=${businessId} and invoice_id=${invoiceId}
    `;
    expect(redemption).toMatchObject({ amountMinor: 2000, count: 1 });
    // Its coupon has settled it at $0: the bill is final with no payment row, and an edit may not
    // silently reopen it.
    const back = await request("PATCH", `/api/appointments/${id}/services/${line.id}`, ownerCookie, { priceMinor: 8000 });
    expect(back.statusCode, back.body).toBe(409);
    expect(back.json()).toMatchObject({ code: "SERVICES_LOCKED_INVOICE_SETTLED", error: "Services are locked once the bill is settled." });
    expect(await invoice(invoiceId)).toMatchObject({ totalMinor: 0, balanceMinor: 0, status: "paid" });
    expect((await detail(id)).servicesEditable).toBe(false);
  });

  it("locks a bill its coupon settled at $0 at checkout - no payment row, no fake one, no reopening", async () => {
    const code = `ZERO${suffix.slice(0, 6)}`.toUpperCase();
    const coupon = await request("POST", "/api/settings/coupons", ownerCookie, { code, kind: "amount", amountMinor: 500000 });
    expect(coupon.statusCode, coupon.body).toBe(201);
    const { id, invoiceId } = await invoicedVisit(employeeA, { appliedDiscountIds: [], couponCode: code, tipMinor: 0 });
    const before = await invoice(invoiceId);
    expect(before).toMatchObject({ totalMinor: 0, balanceMinor: 0, status: "paid" });
    const [payments] = await db<{ count: number }[]>`
      select count(*)::int as count from payments where business_id=${businessId} and invoice_id=${invoiceId}
    `;
    expect(payments!.count).toBe(0);
    const current = await detail(id);
    expect(current.servicesEditable).toBe(false);
    const line = current.services[0]!;
    const list = await request("PUT", `/api/appointments/${id}/services`, ownerCookie,
      { lines: [{ id: line.id, serviceId: groomId }, { serviceId: bathId }] });
    expect(list.statusCode, list.body).toBe(409);
    expect(list.json().code).toBe("SERVICES_LOCKED_INVOICE_SETTLED");
    const price = await request("PATCH", `/api/appointments/${id}/services/${line.id}`, ownerCookie, { priceMinor: 9900 });
    expect(price.statusCode, price.body).toBe(409);
    expect(price.json().code).toBe("SERVICES_LOCKED_INVOICE_SETTLED");
    expect(await invoice(invoiceId)).toEqual(before);
    const [after] = await db<{ count: number }[]>`
      select count(*)::int as count from payments where business_id=${businessId} and invoice_id=${invoiceId}
    `;
    expect(after!.count).toBe(0);
  });

  it("re-pricing an open invoice is the price permission's, whatever the role is called", async () => {
    // A custom desk role - not a groomer, no checkout key - with the all-staff scope.
    const priced = await seat("desk-priced", ["appointments.view", "appointments.edit", "appointments.edit_all_staff", "appointments.service_price_edit"]);
    const unpriced = await seat("desk-unpriced", ["appointments.view", "appointments.edit", "appointments.edit_all_staff"]);
    const { id, invoiceId } = await invoicedVisit();
    const line = (await detail(id)).services[0]!;
    const refused = await request("PATCH", `/api/appointments/${id}/services/${line.id}`, unpriced.cookie, { priceMinor: 4321 });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error).toBe("Missing permission: appointments.service_price_edit");
    const allowed = await request("PATCH", `/api/appointments/${id}/services/${line.id}`, priced.cookie, { priceMinor: 4321 });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(await invoice(invoiceId)).toMatchObject({ id: invoiceId, subtotalMinor: 4321, status: "open" });
  });

  it("refuses both routes once client credit is taken, and changes nothing", async () => {
    const { id, invoiceId } = await invoicedVisit();
    const before = await invoice(invoiceId);
    const credit = await pay(invoiceId, 1000, before.balanceMinor, "client_credit");
    expect(credit.statusCode, credit.body).toBe(201);
    const current = await detail(id);
    expect(current.servicesEditable).toBe(false);
    const line = current.services[0]!;

    const list = await request("PUT", `/api/appointments/${id}/services`, ownerCookie,
      { lines: [{ id: line.id, serviceId: groomId }, { serviceId: bathId }] });
    expect(list.statusCode, list.body).toBe(409);
    expect(list.json()).toMatchObject({
      code: "SERVICES_LOCKED_BY_PAYMENT",
      error: "Services are locked once a payment is recorded. Void the payment to change them."
    });
    const price = await request("PATCH", `/api/appointments/${id}/services/${line.id}`, ownerCookie, { priceMinor: 100 });
    expect(price.statusCode).toBe(409);
    expect(price.json().code).toBe("SERVICES_LOCKED_BY_PAYMENT");
    const duration = await request("PATCH", `/api/appointments/${id}/services/${line.id}`, ownerCookie, { durationMinutes: 90 });
    expect(duration.statusCode).toBe(409);

    expect((await detail(id)).services.map((row) => row.priceMinor)).toEqual([8000]);
    expect(await invoice(invoiceId)).toMatchObject({ totalMinor: before.totalMinor, calculationVersion: 1 });
    expect(await recalculations(invoiceId)).toHaveLength(0);
  });

  it("unlocks again when the only payment is voided, and recomputes the invoice", async () => {
    const { id, invoiceId } = await invoicedVisit();
    const raised = await invoice(invoiceId);
    const cash = await pay(invoiceId, 2000, raised.balanceMinor, "cash");
    expect(cash.statusCode, cash.body).toBe(201);
    const voided = await request("POST", `/api/payments/${cash.json().id}/void`, ownerCookie, { reason: "Wrong visit" });
    expect(voided.statusCode, voided.body).toBe(200);

    const current = await detail(id);
    expect(current.servicesEditable).toBe(true);
    const response = await request("PUT", `/api/appointments/${id}/services`, ownerCookie, {
      version: current.version, lines: [{ id: current.services[0]!.id, serviceId: groomId }, { serviceId: nailsId }]
    });
    expect(response.statusCode, response.body).toBe(200);
    const totals = expectedTotals([8000, 1500], 500);
    expect(await invoice(invoiceId)).toMatchObject({
      id: invoiceId, ...pick(totals), balanceMinor: totals.total, status: "open", calculationVersion: 2
    });
    expect(await recalculations(invoiceId)).toHaveLength(1);
  });

  it("keeps the own-scope rule: a groomer may not edit another groomer's invoiced visit", async () => {
    const { id } = await invoicedVisit(employeeB);
    const line = (await detail(id)).services[0]!;
    const response = await request("PATCH", `/api/appointments/${id}/services/${line.id}`, groomerA, { durationMinutes: 75 });
    expect(response.statusCode, response.body).toBe(403);
    const list = await request("PUT", `/api/appointments/${id}/services`, groomerA,
      { lines: [{ id: line.id, serviceId: groomId }, { serviceId: bathId }] });
    expect(list.statusCode).toBe(403);
  });

  it("still refuses a cancelled visit with the sentence it always had", async () => {
    const id = await book(employeeA, [groomId]);
    await transition(id, "cancelled");
    expect((await detail(id)).servicesEditable).toBe(false);
    const response = await request("PUT", `/api/appointments/${id}/services`, ownerCookie, { serviceIds: [bathId] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Services cannot be changed in the current appointment state");
  });

  it("never leaves the invoice inconsistent when a payment races an edit", async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { id, invoiceId } = await invoicedVisit();
      const raised = await invoice(invoiceId);
      const line = (await detail(id)).services[0]!;
      const [edit, payment] = await Promise.all([
        request("PUT", `/api/appointments/${id}/services`, ownerCookie,
          { lines: [{ id: line.id, serviceId: groomId }, { serviceId: bathId }] }),
        pay(invoiceId, 1000, raised.balanceMinor, "cash")
      ]);
      const paid = payment.statusCode === 201;
      const edited = edit.statusCode === 200;
      // Exactly one of them wins, and the loser says why.
      expect(paid !== edited, `${edit.statusCode} ${edit.body} / ${payment.statusCode} ${payment.body}`).toBe(true);
      if (paid) expect(edit.json().code).toBe("SERVICES_LOCKED_BY_PAYMENT");
      else expect(payment.json().code).toBe("STALE_FINANCIAL_STATE");

      const final = await invoice(invoiceId);
      const [items] = await db<{ sum: number }[]>`
        select coalesce(sum(amount_minor),0)::int as sum from invoice_items where business_id=${businessId} and invoice_id=${invoiceId}
      `;
      const [lines] = await db<{ sum: number }[]>`
        select coalesce(sum(price_minor_snapshot),0)::int as sum from appointment_services
        where business_id=${businessId} and appointment_id=${id}
      `;
      const [recorded] = await db<{ sum: number }[]>`
        select coalesce(sum(amount_minor),0)::int as sum from payments
        where business_id=${businessId} and invoice_id=${invoiceId} and status='recorded'
      `;
      expect(final.subtotalMinor).toBe(items!.sum);
      expect(final.subtotalMinor).toBe(lines!.sum);
      expect(final.totalMinor).toBe(final.subtotalMinor - final.discountMinor + final.taxMinor + final.tipMinor);
      expect(final.balanceMinor).toBe(final.totalMinor - recorded!.sum);
      expect(final).toMatchObject(pick(expectedTotals(paid ? [8000] : [8000, 4000], 500)));
    }
  });
});

function pick(totals: { subtotal: number; discount: number; tax: number; tip: number; total: number }) {
  return {
    subtotalMinor: totals.subtotal, discountMinor: totals.discount, taxMinor: totals.tax,
    tipMinor: totals.tip, totalMinor: totals.total
  };
}
