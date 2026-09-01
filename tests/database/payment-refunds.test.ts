import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { tokenHash } from "../../src/http/context.js";
import { hashPassword } from "../../src/security/passwords.js";
import { IntegrationKeyring } from "../../src/security/integration-encryption.js";
import {
  processSquareWebhooks, squareSignature, squareSignatureHeader
} from "../../src/integrations/square/webhooks.js";
import {
  maxRefundSweepAttempts, paymentRefundIdempotencyKey
} from "../../src/integrations/square/refunds.js";
import { sweepPendingRefunds } from "../../src/integrations/square/sweep.js";
import { SquareApiError } from "../../src/integrations/square/errors.js";
import { squareStub } from "../support/square-stub.js";
import { roleFor } from "../support/roles.js";

/**
 * Giving money back, through the real routes and against a real database.
 *
 * The unit suite holds the arithmetic - the tip-last split, the headroom, the key derivation, the
 * status mapping. This file holds what only a real database and the real routes can show: that the
 * sum ceiling actually holds under the lock rather than in a comment, that a replayed notification
 * converges on one row rather than two, that a failed refund gives its headroom back and stays
 * findable, that voiding a terminal payment is refused while voiding a cash record still works, and
 * that an invoice whose money went back stops calling itself paid without ever claiming the
 * customer owes anything.
 *
 * NOTHING HERE IS SANDBOX-VERIFIED. No Square credentials exist for this project, so Square's
 * answers come from a fixture-shaped stub. What runs for real is everything on our side of the
 * boundary: the routes, the transaction, the constraints, the row-level security and the drain.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const integrationKey = randomBytes(32).toString("base64");
const webhookSignatureKey = randomBytes(32).toString("base64");
const notificationUrl = "http://localhost:3000/webhooks/square";
const merchantId = "MLREFUNDS000001";

const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "square-refunds-test-secret-at-least-32-characters",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false,
  PAWSH_INTEGRATION_ENCRYPTION_KEYS: `1:${integrationKey}`,
  PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE: "1",
  PAWSH_SQUARE_APPLICATION_ID: "sandbox-sq0idb-TEST-APPLICATION",
  PAWSH_SQUARE_APPLICATION_SECRET: "sandbox-sq0csb-TEST-SECRET",
  PAWSH_SQUARE_ENVIRONMENT: "sandbox",
  PAWSH_SQUARE_NOTIFICATION_URL: notificationUrl,
  PAWSH_SQUARE_WEBHOOK_SIGNATURE_KEY: webhookSignatureKey
};

const keyring = IntegrationKeyring.parse(
  config.PAWSH_INTEGRATION_ENCRYPTION_KEYS!, config.PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE!
);

function cookie(response: { headers: Record<string, unknown> }): string {
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

interface RefundRow {
  id: string;
  paymentId: string;
  invoiceId: string;
  amountMinor: number;
  tipRefundedMinor: number;
  currency: string;
  provider: string | null;
  providerRefundId: string | null;
  idempotencyKey: string;
  status: string;
  reason: string | null;
  attempt: number;
  settledAt: Date | null;
  failureReason: string | null;
}

describeDatabase("Payment refunds", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let square: ReturnType<typeof squareStub>;
  let ownerCookie: string;
  let rivalCookie: string;
  let businessId: string;
  let locationId: string;
  let ownerId: string;
  let serviceId: string;
  let customerId: string;
  let petId: string;
  let employeeId: string;
  let deviceId: string;
  const suffix = crypto.randomUUID();
  let appointmentSequence = 0;

  async function drainUntilQuiet(rounds = 5): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      await db`update square_webhook_events set next_attempt_at=now() where processed_at is null`;
      const claimed = await processSquareWebhooks(db, {
        client: square.client, keyring, environment: "sandbox"
      });
      if (claimed === 0) return;
    }
  }

  async function connect(withCookie: string): Promise<void> {
    const started = await app.inject({
      method: "POST", url: "/api/integrations/square/connect", headers: { cookie: withCookie }
    });
    const state = new URL(started.json().authorizeUrl).searchParams.get("state")!;
    const finished = await app.inject({
      method: "GET",
      url: `/api/integrations/square/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: withCookie }
    });
    expect(finished.statusCode).toBe(303);
  }

  async function pairTerminal(label: string): Promise<string> {
    const created = await app.inject({
      method: "POST", url: "/api/integrations/square/devices", headers: { cookie: ownerCookie },
      payload: { locationId, squareLocationId: "LSAMPLE000000001", label }
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const issued = await app.inject({
      method: "POST", url: `/api/integrations/square/devices/${id}/code`,
      headers: { cookie: ownerCookie }
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const [row] = await db<{ deviceCodeId: string }[]>`
      select device_code_id from square_devices where id=${id}
    `;
    square.pairDeviceCode({ deviceCodeId: row!.deviceCodeId, deviceId: `DEV${row!.deviceCodeId}` });
    const refreshed = await app.inject({
      method: "POST", url: `/api/integrations/square/devices/${id}/refresh`,
      headers: { cookie: ownerCookie }
    });
    expect(refreshed.json().pairingStatus).toBe("paired");
    return id;
  }

  /** An invoice built the way the product builds one: a completed appointment, run through checkout. */
  async function invoiceFor(priceMinor: number): Promise<{ id: string; totalMinor: number }> {
    appointmentSequence += 1;
    const day = String(appointmentSequence).padStart(2, "0");
    const start = `2026-12-${day}T17:00:00Z`;
    const end = `2026-12-${day}T18:00:00Z`;
    const [appointment] = await db<{ id: string }[]>`
      insert into appointments
        (business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,status,
         scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,created_by,updated_by)
      values (${businessId},${locationId},${customerId},${petId},${employeeId},${start},${end},
        'completed','America/Los_Angeles',
        ${start}::timestamptz at time zone 'America/Los_Angeles',-480,${ownerId},${ownerId})
      returning id
    `;
    await db`
      insert into appointment_services
        (business_id,appointment_id,service_id,service_name_snapshot,
         duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment!.id},${serviceId},'Full groom',60,${priceMinor})
    `;
    const created = await app.inject({
      method: "POST", url: `/api/appointments/${appointment!.id}/checkout`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { discountMinor: 0, tipMinor: 0 }
    });
    expect(created.statusCode, created.body).toBe(201);
    return { id: created.json().id, totalMinor: created.json().totalMinor };
  }

  /**
   * A settled terminal payment: the whole of Phase F, through the real routes.
   *
   * Returns the Pawsh payment row, which is the only thing a refund is ever taken against.
   */
  async function terminalPayment(input: { serviceMinor: number; tipMinor: number }): Promise<{
    invoiceId: string; paymentId: string; amountMinor: number; tipMinor: number;
  }> {
    const invoice = await invoiceFor(input.serviceMinor);
    const started = await app.inject({
      method: "POST", url: `/api/invoices/${invoice.id}/terminal-checkouts`,
      headers: { cookie: ownerCookie }, payload: { deviceId }
    });
    expect(started.statusCode, started.body).toBe(201);
    const [checkout] = await db<{ squareCheckoutId: string; id: string }[]>`
      select id, square_checkout_id from square_terminal_checkouts
      where business_id=${businessId} and id=${started.json().id}
    `;
    square.completeCheckout({
      checkoutId: checkout!.squareCheckoutId,
      amountMinor: input.serviceMinor,
      tipMinor: input.tipMinor
    });
    const reconciled = await app.inject({
      method: "POST", url: `/api/square/terminal-checkouts/${checkout!.id}/refresh`,
      headers: { cookie: ownerCookie }
    });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json().settled).toBe(true);
    const [payment] = await db<{ id: string; amountMinor: number; providerTipMinor: number }[]>`
      select id, amount_minor, provider_tip_minor from payments
      where business_id=${businessId} and invoice_id=${invoice.id} and provider='square'
    `;
    return {
      invoiceId: invoice.id, paymentId: payment!.id,
      amountMinor: payment!.amountMinor, tipMinor: payment!.providerTipMinor
    };
  }

  async function refund(paymentId: string, body: {
    amountMinor: number; expectedRefundableMinor: number; reason?: string | null;
  }, withCookie = ownerCookie) {
    return app.inject({
      method: "POST", url: `/api/payments/${paymentId}/refunds`,
      headers: { cookie: withCookie, "idempotency-key": crypto.randomUUID() },
      payload: body
    });
  }

  async function refundRows(paymentId: string): Promise<RefundRow[]> {
    return db<RefundRow[]>`
      select id, payment_id, invoice_id, amount_minor, tip_refunded_minor, currency, provider,
        provider_refund_id, idempotency_key, status, reason, attempt, settled_at, failure_reason
      from payment_refunds where payment_id=${paymentId} order by attempt
    `;
  }

  async function invoiceRow(id: string) {
    const [row] = await db<{
      status: string; totalMinor: number; balanceMinor: number; tipMinor: number;
      subtotalMinor: number;
    }[]>`
      select status, total_minor, balance_minor, tip_minor, subtotal_minor
      from invoices where business_id=${businessId} and id=${id}
    `;
    return row!;
  }

  /** The notification Square sends when a refund moves, signed the way Square signs it. */
  async function refundWebhook(providerRefundId: string, eventId = crypto.randomUUID()) {
    const body = Buffer.from(JSON.stringify({
      merchant_id: merchantId,
      type: "refund.updated",
      event_id: eventId,
      created_at: new Date().toISOString(),
      data: {
        type: "refund", id: providerRefundId,
        object: { refund: { id: providerRefundId, status: "COMPLETED" } }
      }
    }), "utf8");
    const posted = await app.inject({
      method: "POST", url: "/webhooks/square", payload: body,
      headers: {
        "content-type": "application/json",
        [squareSignatureHeader]: squareSignature({
          notificationUrl, rawBody: body, signatureKey: webhookSignatureKey
        })
      }
    });
    expect(posted.statusCode).toBe(200);
    return posted.json() as { status: string; eventId: string };
  }

  beforeAll(async () => {
    db = createDatabase(config);
    square = squareStub({ merchantId, refundOutcome: "COMPLETED" });
    app = await createApp(config, db, {
      runWorker: false, serveStatic: false, squareClient: square.client
    });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `refunds-${suffix}@example.test`,
        password: "correct horse refunds salon", businessName: "Refunds Salon"
      }
    });
    ownerCookie = cookie(signup);
    businessId = signup.json().businessId;

    const rival = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `refunds-rival-${suffix}@example.test`,
        password: "correct horse rival refunds", businessName: "Rival Refunds"
      }
    });
    rivalCookie = cookie(rival);

    const [location] = await db<{ id: string }[]>`
      select id from locations where business_id=${businessId} order by created_at limit 1
    `;
    locationId = location!.id;
    const [owner] = await db<{ id: string }[]>`
      select user_id as id from business_memberships
      where business_id=${businessId} and is_owner limit 1
    `;
    ownerId = owner!.id;
    const [service] = await db<{ id: string }[]>`
      insert into services (business_id,name,base_duration_minutes,base_price_minor)
      values (${businessId},'Full groom',60,6500) returning id
    `;
    serviceId = service!.id;
    const [customer] = await db<{ id: string }[]>`
      insert into customers(business_id,first_name,last_name)
      values (${businessId},'Refund','Client') returning id
    `;
    customerId = customer!.id;
    const [pet] = await db<{ id: string }[]>`
      insert into pets(business_id,customer_id,name) values (${businessId},${customerId},'Marmalade')
      returning id
    `;
    petId = pet!.id;
    const [employee] = await db<{ id: string }[]>`
      insert into employees(business_id,display_name) values (${businessId},'Groomer') returning id
    `;
    employeeId = employee!.id;

    // A staff account exists so the permission the refund routes are gated on is the one a
    // receptionist actually holds, rather than owner-bypass.
    const staffToken = crypto.randomUUID();
    const [staff] = await db<{ userId: string }[]>`
      with account as (
        insert into users(email,normalized_email,password_hash)
        values (${`refunds-staff-${suffix}@example.test`},${`refunds-staff-${suffix}@example.test`},
          ${await hashPassword("correct horse refunds staff")})
        returning id
      )
      insert into business_memberships(business_id,user_id,role_id)
      select ${businessId},id,${await roleFor(db, businessId, ['checkout.perform','payments.view'])} from account
      returning user_id
    `;
    await db`
      insert into sessions(user_id,token_hash,expires_at)
      values (${staff!.userId},${tokenHash(staffToken)},now()+interval '1 day')
    `;

    await connect(ownerCookie);
    deviceId = await pairTerminal("Refund counter");
  });

  afterAll(async () => { await app.close(); await db.end(); });

  // ---------------------------------------------------------------------------
  // The happy path, and the two things it must leave behind
  // ---------------------------------------------------------------------------

  it("refunds a terminal payment in full, returns the tip, and stops calling the invoice paid", async () => {
    square.state.refundOutcome = "COMPLETED";
    const payment = await terminalPayment({ serviceMinor: 6_500, tipMinor: 1_000 });
    expect(payment.amountMinor).toBe(7_500);

    const before = await invoiceRow(payment.invoiceId);
    expect(before.status).toBe("paid");

    const issued = await refund(payment.paymentId, {
      amountMinor: 7_500, expectedRefundableMinor: 7_500, reason: "Groom cut short"
    });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json()).toMatchObject({
      status: "completed", settled: true, amountMinor: 7_500,
      // A full refund returns the whole tip, and the row says so rather than leaving it derivable.
      tipRefundedMinor: 1_000, label: "Refunded"
    });
    // No Square identifier ever reaches the client.
    expect(issued.json().providerRefundId).toBeUndefined();

    const [row] = await refundRows(payment.paymentId);
    expect(row).toMatchObject({
      status: "completed", amountMinor: 7_500, tipRefundedMinor: 1_000,
      provider: "square", currency: "USD", attempt: 1, reason: "Groom cut short"
    });
    expect(row!.settledAt).not.toBeNull();
    expect(row!.providerRefundId).toBeTruthy();
    expect(row!.failureReason).toBeNull();

    // THE INVOICE DOES NOT MOVE. Not the total, not the tip, not the balance - only the status.
    const after = await invoiceRow(payment.invoiceId);
    expect(after.totalMinor).toBe(before.totalMinor);
    expect(after.tipMinor).toBe(before.tipMinor);
    expect(after.balanceMinor).toBe(0);
    expect(after.status).toBe("refunded");

    // THE ORIGINAL PAYMENT IS UNTOUCHED. It is still what the customer's card was charged.
    const [original] = await db<{ amountMinor: number; status: string; providerTipMinor: number }[]>`
      select amount_minor, status, provider_tip_minor from payments
      where business_id=${businessId} and id=${payment.paymentId}
    `;
    expect(original).toMatchObject({ amountMinor: 7_500, status: "recorded", providerTipMinor: 1_000 });
  });

  it("keeps a fully refunded invoice out of the outstanding list", async () => {
    // `invoice_outstanding` is a partial index on `status in ('open','partially_paid')`. The new
    // values are deliberately outside it: the balance is zero and nothing is owed, so the invoice
    // must not appear in front of whoever chases money.
    square.state.refundOutcome = "COMPLETED";
    const payment = await terminalPayment({ serviceMinor: 4_000, tipMinor: 0 });
    await refund(payment.paymentId, { amountMinor: 4_000, expectedRefundableMinor: 4_000 });
    const outstanding = await db<{ id: string }[]>`
      select id from invoices
      where business_id=${businessId} and status in ('open','partially_paid')
        and id=${payment.invoiceId}
    `;
    expect(outstanding).toHaveLength(0);
    // And it is still the appointment's one active invoice, because it is not void.
    const [active] = await db<{ count: number }[]>`
      select count(*)::int as count from invoices
      where business_id=${businessId} and id=${payment.invoiceId} and status<>'void'
    `;
    expect(active!.count).toBe(1);
  });

  it("takes nothing from the tip on a partial refund the service amount can absorb", async () => {
    square.state.refundOutcome = "COMPLETED";
    const payment = await terminalPayment({ serviceMinor: 6_500, tipMinor: 1_000 });
    const issued = await refund(payment.paymentId, {
      amountMinor: 3_000, expectedRefundableMinor: 7_500
    });
    expect(issued.statusCode, issued.body).toBe(201);
    // The customer gets the disputed service money back and the groomer keeps every cent of the
    // gratuity, because the complaint was about the service and there is service money left.
    expect(issued.json()).toMatchObject({ amountMinor: 3_000, tipRefundedMinor: 0 });
    expect((await invoiceRow(payment.invoiceId)).status).toBe("partially_refunded");
  });

  // ---------------------------------------------------------------------------
  // The ceiling
  // ---------------------------------------------------------------------------

  it("adds two partial refunds to exactly the payment, and reaches the tip only at the end", async () => {
    square.state.refundOutcome = "COMPLETED";
    const payment = await terminalPayment({ serviceMinor: 6_500, tipMinor: 1_000 });

    const first = await refund(payment.paymentId, {
      amountMinor: 6_000, expectedRefundableMinor: 7_500
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().tipRefundedMinor).toBe(0);
    expect((await invoiceRow(payment.invoiceId)).status).toBe("partially_refunded");

    const second = await refund(payment.paymentId, {
      amountMinor: 1_500, expectedRefundableMinor: 1_500
    });
    expect(second.statusCode, second.body).toBe(201);
    // $500 of service was still owed back, and only the remaining $1,000 came out of the tip.
    expect(second.json().tipRefundedMinor).toBe(1_000);

    const rows = await refundRows(payment.paymentId);
    expect(rows.map((row) => row.amountMinor)).toEqual([6_000, 1_500]);
    expect(rows.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(7_500);
    expect(rows.reduce((sum, row) => sum + row.tipRefundedMinor, 0)).toBe(1_000);
    expect(rows.map((row) => row.attempt)).toEqual([1, 2]);
    // Two attempts, two different keys. One key for both would make them the same request to
    // Square, and the second refund would silently never happen.
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(2);

    expect((await invoiceRow(payment.invoiceId)).status).toBe("refunded");
  });

  it("refuses a refund larger than what is left", async () => {
    square.state.refundOutcome = "COMPLETED";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    await refund(payment.paymentId, { amountMinor: 2_000, expectedRefundableMinor: 5_000 });

    const refused = await refund(payment.paymentId, {
      amountMinor: 3_001, expectedRefundableMinor: 3_000
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("REFUND_EXCEEDS_REMAINING");
    // Refused entirely: no second row, and nothing was sent to Square.
    expect(await refundRows(payment.paymentId)).toHaveLength(1);
  });

  it("counts a PENDING refund against the ceiling, so a retry cannot over-refund", async () => {
    // The case the whole `pending` accounting exists for. The first refund has moved no money yet,
    // but Square may be moving it; a second request that ignored it would ask for the same money
    // again and Square would agree to both.
    square.state.refundOutcome = "PENDING";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    const first = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ status: "pending", settled: false, inFlight: true });

    const refused = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("REFUND_EXCEEDS_REMAINING");
    expect(await refundRows(payment.paymentId)).toHaveLength(1);

    const state = await app.inject({
      method: "GET", url: `/api/payments/${payment.paymentId}/refunds`,
      headers: { cookie: ownerCookie }
    });
    expect(state.json()).toMatchObject({
      refundableMinor: 0,
      // Not yet money: a pending refund is held against the ceiling but counts toward nothing.
      refundedMinor: 0
    });
    // The invoice has not moved on a refund that has not settled.
    expect((await invoiceRow(payment.invoiceId)).status).toBe("paid");
  });

  it("releases the headroom a failed refund was holding, and keeps the row forever", async () => {
    square.state.refundOutcome = "REJECTED";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    const rejected = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000
    });
    expect(rejected.statusCode, rejected.body).toBe(201);
    expect(rejected.json()).toMatchObject({
      status: "failed", settled: false, failed: true, label: "Refund failed"
    });
    expect(rejected.json().failureReason).toBeTruthy();
    expect((await invoiceRow(payment.invoiceId)).status).toBe("paid");

    // The headroom is back, so the salon can try again.
    square.state.refundOutcome = "COMPLETED";
    const retried = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000
    });
    expect(retried.statusCode, retried.body).toBe(201);
    expect(retried.json().status).toBe("completed");

    // Both rows are still there. The failed one is the only evidence somebody tried, and a salon
    // that cannot see it will try again believing it is the first time.
    const rows = await refundRows(payment.paymentId);
    expect(rows.map((row) => row.status)).toEqual(["failed", "completed"]);
    expect(rows[0]!.failureReason).toBeTruthy();
    expect(rows[0]!.settledAt).toBeNull();
    expect((await invoiceRow(payment.invoiceId)).status).toBe("refunded");
  });

  it("refuses to refund a payment Pawsh did not take through a processor", async () => {
    const invoice = await invoiceFor(4_000);
    const paid = await app.inject({
      method: "POST", url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { amountMinor: 4_000, expectedBalanceMinor: 4_000, method: "cash" }
    });
    expect(paid.statusCode).toBe(201);
    const refused = await refund(paid.json().id, {
      amountMinor: 4_000, expectedRefundableMinor: 4_000
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("PAYMENT_NOT_REFUNDABLE");
    expect(await refundRows(paid.json().id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Replay
  // ---------------------------------------------------------------------------

  it("converges a replayed refund.updated on one row rather than two", async () => {
    square.state.refundOutcome = "PENDING";
    const payment = await terminalPayment({ serviceMinor: 6_500, tipMinor: 1_000 });
    const issued = await refund(payment.paymentId, {
      amountMinor: 7_500, expectedRefundableMinor: 7_500
    });
    expect(issued.json().status).toBe("pending");

    const [pending] = await refundRows(payment.paymentId);
    const providerRefundId = pending!.providerRefundId!;
    expect(providerRefundId).toBeTruthy();
    square.settleRefund({ refundId: providerRefundId, status: "COMPLETED" });

    // Square retries a notification about eleven times over twenty-four hours. Three deliveries -
    // two distinct events and one exact redelivery - must all land on the same row.
    const eventId = crypto.randomUUID();
    expect((await refundWebhook(providerRefundId, eventId)).status).toBe("recorded");
    expect((await refundWebhook(providerRefundId, eventId)).status).toBe("duplicate");
    await refundWebhook(providerRefundId);
    await drainUntilQuiet();

    const rows = await refundRows(payment.paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", amountMinor: 7_500, tipRefundedMinor: 1_000 });
    expect((await invoiceRow(payment.invoiceId)).status).toBe("refunded");
    expect((await invoiceRow(payment.invoiceId)).balanceMinor).toBe(0);

    const events = await db<{ status: string }[]>`
      select status from square_webhook_events where event_type='refund.updated'
        and payload->'data'->'object'->'refund'->>'id'=${providerRefundId}
    `;
    expect(events.every((event) => event.status === "processed")).toBe(true);
  });

  it("parks a refund.updated for a refund that was not issued through Pawsh", async () => {
    // A salon refunding a payment directly in its own Square dashboard is not a Pawsh ledger
    // event. Manufacturing a row for it would be inventing a ledger entry.
    const stranger = `PAYSTRANGER_RFND${randomBytes(4).toString("hex")}`;
    await refundWebhook(stranger);
    await drainUntilQuiet();
    const [event] = await db<{ status: string; lastError: string | null }[]>`
      select status, last_error from square_webhook_events
      where payload->'data'->'object'->'refund'->>'id'=${stranger}
    `;
    expect(event!.status).toBe("parked");
    expect(event!.lastError).toContain(stranger);
    const [rows] = await db<{ count: number }[]>`
      select count(*)::int as count from payment_refunds where provider_refund_id=${stranger}
    `;
    expect(rows!.count).toBe(0);
  });

  it("answers a replayed refund request with the refund it already made", async () => {
    square.state.refundOutcome = "COMPLETED";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    const key = crypto.randomUUID();
    const body = { amountMinor: 2_000, expectedRefundableMinor: 5_000, reason: "Half off" };
    const first = await app.inject({
      method: "POST", url: `/api/payments/${payment.paymentId}/refunds`,
      headers: { cookie: ownerCookie, "idempotency-key": key }, payload: body
    });
    expect(first.statusCode, first.body).toBe(201);
    const replayed = await app.inject({
      method: "POST", url: `/api/payments/${payment.paymentId}/refunds`,
      headers: { cookie: ownerCookie, "idempotency-key": key }, payload: body
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().id).toBe(first.json().id);
    expect(await refundRows(payment.paymentId)).toHaveLength(1);
  });

  it("derives every stored idempotency key from the row that holds it", async () => {
    // The key is the only thing standing between a lost response and a second refund, so it has to
    // be reproducible from disk rather than merely believed to have been computed correctly once.
    square.state.refundOutcome = "COMPLETED";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    await refund(payment.paymentId, { amountMinor: 2_000, expectedRefundableMinor: 5_000 });
    await refund(payment.paymentId, { amountMinor: 3_000, expectedRefundableMinor: 3_000 });
    for (const row of await refundRows(payment.paymentId)) {
      expect(row.idempotencyKey).toBe(paymentRefundIdempotencyKey({
        businessId, paymentId: row.paymentId, amountMinor: row.amountMinor, attempt: row.attempt
      }));
      expect(row.idempotencyKey.length).toBeLessThanOrEqual(45);
    }
  });

  // ---------------------------------------------------------------------------
  // Void
  // ---------------------------------------------------------------------------

  it("refuses to void a terminal payment, and points at refunding instead", async () => {
    square.state.refundOutcome = "COMPLETED";
    const payment = await terminalPayment({ serviceMinor: 6_500, tipMinor: 1_000 });
    const before = await invoiceRow(payment.invoiceId);

    const refused = await app.inject({
      method: "POST", url: `/api/payments/${payment.paymentId}/void`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { reason: "Wrong customer" }
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("PAYMENT_REQUIRES_REFUND");

    // Nothing moved. This also closes the defect the refusal exists for: void recomputed the
    // balance from `total_minor` and never reversed the tip raise, so voiding a terminal payment
    // used to leave the invoice inflated by exactly the tip the customer had already given.
    const after = await invoiceRow(payment.invoiceId);
    expect(after).toEqual(before);
    const [row] = await db<{ status: string }[]>`
      select status from payments where business_id=${businessId} and id=${payment.paymentId}
    `;
    expect(row!.status).toBe("recorded");
  });

  it("still voids a cash record, because Pawsh never moved that money", async () => {
    const invoice = await invoiceFor(4_000);
    const paid = await app.inject({
      method: "POST", url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { amountMinor: 4_000, expectedBalanceMinor: 4_000, method: "cash" }
    });
    expect(paid.statusCode).toBe(201);
    expect((await invoiceRow(invoice.id)).status).toBe("paid");

    const voided = await app.inject({
      method: "POST", url: `/api/payments/${paid.json().id}/void`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { reason: "Keyed the wrong amount" }
    });
    expect(voided.statusCode, voided.body).toBe(200);
    const after = await invoiceRow(invoice.id);
    expect(after.balanceMinor).toBe(4_000);
    expect(after.status).toBe("open");
  });

  it("gives an outstanding status back when a void puts money owed back on a refunded invoice", async () => {
    // An invoice settled by a card payment and a cash payment, the card half refunded, then the
    // cash half voided. Money is owed again, so the honest status is an outstanding one - a
    // refunded label over a live balance would hide it from every list that chases payment.
    square.state.refundOutcome = "COMPLETED";
    const invoice = await invoiceFor(6_000);
    const cash = await app.inject({
      method: "POST", url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { amountMinor: 2_000, expectedBalanceMinor: 6_000, method: "cash" }
    });
    expect(cash.statusCode).toBe(201);

    const started = await app.inject({
      method: "POST", url: `/api/invoices/${invoice.id}/terminal-checkouts`,
      headers: { cookie: ownerCookie }, payload: { deviceId }
    });
    expect(started.statusCode, started.body).toBe(201);
    const [checkout] = await db<{ id: string; squareCheckoutId: string }[]>`
      select id, square_checkout_id from square_terminal_checkouts
      where business_id=${businessId} and id=${started.json().id}
    `;
    square.completeCheckout({
      checkoutId: checkout!.squareCheckoutId, amountMinor: 4_000, tipMinor: 0
    });
    await app.inject({
      method: "POST", url: `/api/square/terminal-checkouts/${checkout!.id}/refresh`,
      headers: { cookie: ownerCookie }
    });
    expect((await invoiceRow(invoice.id)).status).toBe("paid");

    const [card] = await db<{ id: string }[]>`
      select id from payments where business_id=${businessId} and invoice_id=${invoice.id}
        and provider='square'
    `;
    await refund(card!.id, { amountMinor: 4_000, expectedRefundableMinor: 4_000 });
    expect((await invoiceRow(invoice.id)).status).toBe("partially_refunded");

    const voided = await app.inject({
      method: "POST", url: `/api/payments/${cash.json().id}/void`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { reason: "Cash was never handed over" }
    });
    expect(voided.statusCode, voided.body).toBe(200);
    const after = await invoiceRow(invoice.id);
    expect(after.balanceMinor).toBe(2_000);
    expect(after.status).toBe("partially_paid");

    // And settling it again does NOT write `paid` over the fact that money went back. Every write
    // path that closes an invoice goes through one resolver, which is what makes this hold: the
    // manual payment route, the void route, the Terminal reconciler and the refund transaction all
    // derive the status from the same sums rather than each choosing a literal.
    const settled = await app.inject({
      method: "POST", url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { amountMinor: 2_000, expectedBalanceMinor: 2_000, method: "cash" }
    });
    expect(settled.statusCode, settled.body).toBe(201);
    const resettled = await invoiceRow(invoice.id);
    expect(resettled.balanceMinor).toBe(0);
    expect(resettled.status).toBe("partially_refunded");
  });

  // ---------------------------------------------------------------------------
  // Tenancy
  // ---------------------------------------------------------------------------

  it("answers every refund route with 404 for another salon, and changes nothing", async () => {
    square.state.refundOutcome = "COMPLETED";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    const issued = await refund(payment.paymentId, {
      amountMinor: 2_000, expectedRefundableMinor: 5_000
    });
    expect(issued.statusCode).toBe(201);
    const refundId = issued.json().id as string;
    const before = await refundRows(payment.paymentId);
    const invoiceBefore = await invoiceRow(payment.invoiceId);

    const attempts = [
      app.inject({
        method: "GET", url: `/api/payments/${payment.paymentId}/refunds`,
        headers: { cookie: rivalCookie }
      }),
      app.inject({
        method: "POST", url: `/api/payments/${payment.paymentId}/refunds`,
        headers: { cookie: rivalCookie, "idempotency-key": crypto.randomUUID() },
        payload: { amountMinor: 3_000, expectedRefundableMinor: 3_000 }
      }),
      app.inject({
        method: "POST", url: `/api/payment-refunds/${refundId}/refresh`,
        headers: { cookie: rivalCookie }
      })
    ];
    for (const response of await Promise.all(attempts)) {
      // 404, not 403: the other salon must not learn that this payment exists.
      expect(response.statusCode, response.body).toBe(404);
    }
    expect(await refundRows(payment.paymentId)).toEqual(before);
    expect(await invoiceRow(payment.invoiceId)).toEqual(invoiceBefore);
    const [rivalRows] = await db<{ count: number }[]>`
      select count(*)::int as count from payment_refunds where business_id<>${businessId}
        and payment_id=${payment.paymentId}
    `;
    expect(rivalRows!.count).toBe(0);
  });

  it("hides another salon's refunds from a tenant-scoped session entirely", async () => {
    // Under a role that cannot bypass RLS, because the migration runner owns these tables and a
    // table owner is exempt from its own policies unless `force row level security` is set. A test
    // run as the owner would pass whether or not the policy existed, which is worse than no test.
    square.state.refundOutcome = "COMPLETED";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    const issued = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000
    });
    expect(issued.statusCode).toBe(201);
    await db.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname='pawsh_refund_rls_test') then
          create role pawsh_refund_rls_test nologin nosuperuser nobypassrls;
        end if;
      end $$;
      grant usage on schema public to pawsh_refund_rls_test;
      grant select,insert,update,delete on payment_refunds to pawsh_refund_rls_test;
    `);

    await db.begin(async (tx) => {
      await tx`set local role pawsh_refund_rls_test`;
      // Another salon's session sees nothing at all - not a filtered listing, but no reachable row.
      await tx`select set_config('app.business_id',${crypto.randomUUID()},true)`;
      const [hidden] = await tx<{ count: number }[]>`
        select count(*)::int as count from payment_refunds
      `;
      expect(hidden!.count).toBe(0);
      const targeted = await tx<{ id: string }[]>`
        select id from payment_refunds where id=${issued.json().id}
      `;
      expect(targeted).toHaveLength(0);

      // Its own session sees its own rows, so the policy is filtering by tenant rather than
      // refusing everything.
      await tx`select set_config('app.business_id',${businessId},true)`;
      const mine = await tx<{ id: string }[]>`
        select id from payment_refunds where id=${issued.json().id}
      `;
      expect(mine).toHaveLength(1);

      // And it cannot write a row into somebody else's ledger.
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint`
          insert into payment_refunds
            (business_id, payment_id, invoice_id, amount_minor, currency, idempotency_key,
             status, requested_by)
          values (${crypto.randomUUID()}, ${payment.paymentId}, ${payment.invoiceId}, 100, 'USD',
            ${crypto.randomUUID()}, 'pending', ${ownerId})
        `;
      })).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  it("settles a pending refund when an operator asks Square directly", async () => {
    square.state.refundOutcome = "PENDING";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    const issued = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000
    });
    expect(issued.json().status).toBe("pending");
    const [row] = await refundRows(payment.paymentId);
    square.settleRefund({ refundId: row!.providerRefundId!, status: "COMPLETED" });

    const refreshed = await app.inject({
      method: "POST", url: `/api/payment-refunds/${row!.id}/refresh`,
      headers: { cookie: ownerCookie }
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json()).toMatchObject({ status: "completed", settled: true });
    expect((await invoiceRow(payment.invoiceId)).status).toBe("refunded");

    // A second refresh converges rather than settling twice.
    const again = await app.inject({
      method: "POST", url: `/api/payment-refunds/${row!.id}/refresh`,
      headers: { cookie: ownerCookie }
    });
    expect(again.statusCode).toBe(200);
    expect(await refundRows(payment.paymentId)).toHaveLength(1);
  });

  it("refuses to record a refund Square settled for a different amount", async () => {
    // `completed` would post an amount we do not recognise; `failed` would release headroom for
    // money Square may have moved. Neither is true, so the row rests at `needs_review` - the state
    // `square_terminal_checkouts` has had since 0036 and `payment_refunds` gained in 0039.
    //
    // It used to stay `pending`, which was wrong in two ways that compound: on screen it was
    // indistinguishable from a refund Square simply had not finished, so an operator was told to
    // wait for something that was never coming; and in the drain it stayed claimable forever,
    // re-reading an answer that had already been read and understood.
    square.state.refundOutcome = "PENDING";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    const issued = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000
    });
    const [row] = await refundRows(payment.paymentId);
    square.settleRefund({
      refundId: row!.providerRefundId!, status: "COMPLETED", amountMinor: 4_000
    });

    const refreshed = await app.inject({
      method: "POST", url: `/api/payment-refunds/${row!.id}/refresh`,
      headers: { cookie: ownerCookie }
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      status: "needs_review", settled: false, failed: false, needsReview: true
    });
    expect(refreshed.json().failureReason).toContain("does not match");
    expect((await invoiceRow(payment.invoiceId)).status).toBe("paid");
    expect(issued.json().status).toBe("pending");

    // The disagreement is a document a person reads, exactly as a checkout mismatch is, and it
    // names both sides rather than only the complaint.
    const [parked] = await db<{ status: string; mismatch: { reason: string;
      expected: number; received: number } }[]>`
      select status, mismatch from payment_refunds where id=${row!.id}
    `;
    expect(parked!.status).toBe("needs_review");
    expect(parked!.mismatch.reason).toBe("amount");
    expect(parked!.mismatch.expected).toBe(5_000);
    expect(parked!.mismatch.received).toBe(4_000);

    // The headroom is STILL held, which is the point rather than a side effect: what Square did
    // with this money is exactly what nobody knows, so a second refund on top of it must stay
    // refused until a person resolves the first.
    const state = await app.inject({
      method: "GET", url: `/api/payments/${payment.paymentId}/refunds`,
      headers: { cookie: ownerCookie }
    });
    expect(state.json().refundableMinor).toBe(0);
    const second = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("REFUND_EXCEEDS_REMAINING");

    // And it is out of the drain's way: a row waiting on a person is not waiting on Square.
    const [claimable] = await db<{ count: number }[]>`
      select count(*)::int as count from payment_refunds
      where id=${row!.id} and status='pending'
    `;
    expect(claimable!.count).toBe(0);

    const [audited] = await db<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where business_id=${businessId} and action='payment.refund.mismatch' and resource_id=${row!.id}
    `;
    expect(audited!.count).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // Recovery without a webhook and without a person.
  // ---------------------------------------------------------------------------

  /** The worker's refund recovery pass, run directly rather than waiting out a tick. */
  async function sweepRefunds() {
    return sweepPendingRefunds(db, { client: square.client, keyring, environment: "sandbox" });
  }

  /**
   * Makes ONE refund due now and every other one not due.
   *
   * Both halves are needed, for the reason the checkout suite spells out: the sweep's claim is
   * global and bounded, oldest first, and the isolated test database persists between runs - so
   * rows left pending by earlier tests and earlier runs are older than this one and would fill the
   * batch ahead of it.
   */
  async function refundDue(refundId: string): Promise<void> {
    await db`
      update payment_refunds
      set next_sweep_at=case when id=${refundId} then now() else now() + interval '1 day' end
      where status='pending'
    `;
  }

  async function refundSweepAttempts(refundId: string): Promise<number> {
    const [row] = await db<{ sweepAttempts: number }[]>`
      select sweep_attempts from payment_refunds
      where business_id=${businessId} and id=${refundId}
    `;
    return row!.sweepAttempts;
  }

  it("settles a refund from the sweep alone when no webhook ever arrives", async () => {
    square.state.refundOutcome = "PENDING";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    const issued = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000
    });
    const refundId = issued.json().id as string;
    const [row] = await refundRows(payment.paymentId);

    // Square finishes the refund and tells nobody. Before the sweep existed, this row could only
    // be finished by a person pressing refresh.
    square.settleRefund({ refundId: row!.providerRefundId!, status: "COMPLETED" });

    // The grace period holds the sweep off while the notification still might arrive.
    await sweepRefunds();
    expect(await refundSweepAttempts(refundId)).toBe(0);

    await refundDue(refundId);
    await sweepRefunds();

    const settled = await app.inject({
      method: "GET", url: `/api/payments/${payment.paymentId}/refunds`,
      headers: { cookie: ownerCookie }
    });
    expect(settled.json().refunds[0]).toMatchObject({ status: "completed", settled: true });
    expect(settled.json().refundedMinor).toBe(5_000);
    // The invoice follows, exactly as it would have through the webhook.
    expect((await invoiceRow(payment.invoiceId)).status).toBe("refunded");
  });

  it("finishes a refund whose create response was lost, without refunding twice", async () => {
    square.state.refundOutcome = "PENDING";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    const issued = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000
    });
    const refundId = issued.json().id as string;

    // The state no notification can ever resolve: the row holds a derived key and no provider
    // reference, so `findRefundByProviderId` has nothing to match on. Only a re-send can finish it.
    await db`update payment_refunds set provider_refund_id=null where id=${refundId}`;
    const before = square.state.calls.filter((call) => call.method === "createRefund").length;

    await refundDue(refundId);
    await sweepRefunds();

    // Square answered the repeated key with the refund it already made rather than a second one.
    const after = square.state.calls.filter((call) => call.method === "createRefund").length;
    expect(after).toBeGreaterThan(before);
    const rows = await refundRows(payment.paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountMinor).toBe(5_000);
  });

  it("gives up on a refund it cannot confirm and puts it in front of a person", async () => {
    square.state.refundOutcome = "PENDING";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    const issued = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000
    });
    const refundId = issued.json().id as string;

    // Square will not answer about this refund, ever.
    square.state.failAlways.set("retrieveRefund",
      new SquareApiError("square_unavailable", "Square is unavailable", 503));
    try {
      for (let attempt = 0; attempt <= maxRefundSweepAttempts; attempt += 1) {
        await refundDue(refundId);
        await sweepRefunds();
      }
    } finally {
      square.state.failAlways.delete("retrieveRefund");
    }

    const [parked] = await db<{ status: string; mismatch: { reason: string } }[]>`
      select status, mismatch from payment_refunds where id=${refundId}
    `;
    // Never `failed`: that would say the customer did not get their money, and release the
    // headroom for money Square may well have moved. Never `completed` either.
    expect(parked!.status).toBe("needs_review");
    expect(parked!.mismatch.reason).toBe("unconfirmed_after_sweeps");

    // Out of the drain, and still holding its headroom.
    const settled = await refundSweepAttempts(refundId);
    await refundDue(refundId);
    await sweepRefunds();
    expect(await refundSweepAttempts(refundId)).toBe(settled);

    const state = await app.inject({
      method: "GET", url: `/api/payments/${payment.paymentId}/refunds`,
      headers: { cookie: ownerCookie }
    });
    expect(state.json().refundableMinor).toBe(0);
    expect(state.json().refundedMinor).toBe(0);
  });

  it("writes an audit trail for the request and the settlement", async () => {
    square.state.refundOutcome = "COMPLETED";
    const payment = await terminalPayment({ serviceMinor: 5_000, tipMinor: 0 });
    const issued = await refund(payment.paymentId, {
      amountMinor: 5_000, expectedRefundableMinor: 5_000, reason: "Wrong groom"
    });
    const actions = await db<{ action: string }[]>`
      select action from audit_events
      where business_id=${businessId} and resource_id=${issued.json().id} order by created_at
    `;
    expect(actions.map((row) => row.action))
      .toEqual(["payment.refund.request", "payment.refund.completed"]);
  });
});
