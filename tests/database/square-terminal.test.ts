import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { tokenHash } from "../../src/http/context.js";
import { hashPassword } from "../../src/security/passwords.js";
import { IntegrationKeyring } from "../../src/security/integration-encryption.js";
import { SquareApiError } from "../../src/integrations/square/errors.js";
import {
  processSquareWebhooks, squareSignature, squareSignatureHeader
} from "../../src/integrations/square/webhooks.js";
import {
  expireStaleDeviceCodes, terminalCheckoutIdempotencyKey
} from "../../src/integrations/square/terminal.js";
import { squareStub } from "../support/square-stub.js";

/**
 * Pairing a terminal, taking a payment on it, and every way that goes wrong.
 *
 * The unit suite holds the arithmetic - the idempotency derivation, the reconciliation decision,
 * the status mapping. This file holds what only a real database and the real routes can show: that
 * a retry charges once, that a tip raises an invoice by exactly what the customer left, that a
 * replayed webhook converges on one payment row, and that every failure the analysis named leaves
 * the ledger honest rather than leaving a screen saying "paid".
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
const merchantId = "MLTERMINAL000001";

const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "square-terminal-test-secret-at-least-32-characters",
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

describeDatabase("Square Terminal capture", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let square: ReturnType<typeof squareStub>;
  let ownerCookie: string;
  let staffCookie: string;
  let rivalCookie: string;
  let businessId: string;
  let rivalBusinessId: string;
  let locationId: string;
  let rivalLocationId: string;
  let ownerId: string;
  let serviceId: string;
  let customerId: string;
  let petId: string;
  let employeeId: string;
  const suffix = crypto.randomUUID();
  let appointmentSequence = 0;

  async function drain(): Promise<number> {
    return processSquareWebhooks(db, { client: square.client, keyring, environment: "sandbox" });
  }

  /** Runs the drain until every claimable row has come to rest, without waiting out the backoff. */
  async function drainUntilQuiet(rounds = 5): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      await db`update square_webhook_events set next_attempt_at=now() where processed_at is null`;
      if (await drain() === 0) return;
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

  /** Names a terminal, gets a code, and pairs it - the whole of Phase D, through the routes. */
  async function pairTerminal(label: string, options: {
    withCookie?: string; business?: string; location?: string;
  } = {}): Promise<{ deviceId: string; deviceCodeId: string; squareDeviceId: string }> {
    const used = options.withCookie ?? ownerCookie;
    const created = await app.inject({
      method: "POST", url: "/api/integrations/square/devices", headers: { cookie: used },
      payload: {
        locationId: options.location ?? locationId,
        squareLocationId: "LSAMPLE000000001",
        label
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    const deviceId = created.json().id as string;
    const issued = await app.inject({
      method: "POST", url: `/api/integrations/square/devices/${deviceId}/code`,
      headers: { cookie: used }
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const [row] = await db<{ deviceCodeId: string }[]>`
      select device_code_id from square_devices where id=${deviceId}
    `;
    const deviceCodeId = row!.deviceCodeId;
    const squareDeviceId = `DEVICE${deviceCodeId}`;
    square.pairDeviceCode({ deviceCodeId, deviceId: squareDeviceId });
    const refreshed = await app.inject({
      method: "POST", url: `/api/integrations/square/devices/${deviceId}/refresh`,
      headers: { cookie: used }
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json().pairingStatus).toBe("paired");
    return { deviceId, deviceCodeId, squareDeviceId };
  }

  /**
   * An invoice built the way the product builds one: a completed appointment run through the real
   * checkout route with no tip, which is what a Terminal-capture invoice is.
   */
  async function terminalInvoice(): Promise<{ id: string; balanceMinor: number; totalMinor: number }> {
    appointmentSequence += 1;
    const day = String(appointmentSequence).padStart(2, "0");
    const start = `2026-11-${day}T17:00:00Z`;
    const end = `2026-11-${day}T18:00:00Z`;
    const [appointment] = await db<{ id: string }[]>`
      insert into appointments
        (business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,status,
         scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,created_by,updated_by)
      values (${businessId},${locationId},${customerId},${petId},${employeeId},${start},${end},
        'completed','America/Los_Angeles',
        ${start}::timestamptz at time zone 'America/Los_Angeles',-420,${ownerId},${ownerId})
      returning id
    `;
    await db`
      insert into appointment_services
        (business_id,appointment_id,service_id,service_name_snapshot,
         duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment!.id},${serviceId},'Full groom',60,6500)
    `;
    const created = await app.inject({
      method: "POST", url: `/api/appointments/${appointment!.id}/checkout`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { discountMinor: 0, tipMinor: 0 }
    });
    expect(created.statusCode, created.body).toBe(201);
    const invoice = created.json();
    return {
      id: invoice.id, balanceMinor: invoice.balanceMinor, totalMinor: invoice.totalMinor
    };
  }

  async function startCapture(invoiceId: string, deviceId: string, withCookie = ownerCookie) {
    return app.inject({
      method: "POST", url: `/api/invoices/${invoiceId}/terminal-checkouts`,
      headers: { cookie: withCookie }, payload: { deviceId }
    });
  }

  async function invoiceRow(id: string) {
    const [row] = await db<{
      status: string; tipMinor: number; totalMinor: number; balanceMinor: number;
      subtotalMinor: number; taxMinor: number; discountMinor: number;
    }[]>`
      select status, tip_minor, total_minor, balance_minor, subtotal_minor, tax_minor, discount_minor
      from invoices where business_id=${businessId} and id=${id}
    `;
    return row!;
  }

  async function checkoutRow(id: string) {
    const [row] = await db<{
      status: string; squareCheckoutId: string | null; idempotencyKey: string; attempt: number;
      paymentId: string | null; cancelReason: string | null; lastError: string | null;
      reconciledAt: Date | null; mismatchText: string | null; amountMinor: number;
    }[]>`
      select status, square_checkout_id, idempotency_key, attempt, payment_id, cancel_reason,
        last_error, reconciled_at, mismatch::text as mismatch_text, amount_minor
      from square_terminal_checkouts where business_id=${businessId} and id=${id}
    `;
    return row!;
  }

  async function squarePayments(invoiceId: string) {
    return db<{
      id: string; amountMinor: number; providerPaymentId: string; providerTipMinor: number;
      method: string; status: string;
    }[]>`
      select id, amount_minor, provider_payment_id, provider_tip_minor, method, status
      from payments where business_id=${businessId} and invoice_id=${invoiceId}
        and provider='square' order by recorded_at
    `;
  }

  /** The webhook Square sends when a terminal finishes, signed the way Square signs it. */
  async function terminalWebhook(squareCheckoutId: string) {
    const body = Buffer.from(JSON.stringify({
      merchant_id: merchantId,
      type: "terminal.checkout.updated",
      event_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      data: { type: "checkout.event", id: squareCheckoutId, object: { checkout: { id: squareCheckoutId } } }
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
    return posted.json().eventId as string;
  }

  beforeAll(async () => {
    db = createDatabase(config);
    square = squareStub({ merchantId });
    app = await createApp(config, db, {
      runWorker: false, serveStatic: false, squareClient: square.client
    });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `terminal-${suffix}@example.test`,
        password: "correct horse terminal salon", businessName: "Terminal Salon"
      }
    });
    ownerCookie = cookie(signup);
    businessId = signup.json().businessId;

    const rival = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `terminal-rival-${suffix}@example.test`,
        password: "correct horse rival terminal", businessName: "Rival Terminal"
      }
    });
    rivalCookie = cookie(rival);
    rivalBusinessId = rival.json().businessId;

    [locationId, rivalLocationId] = await Promise.all(
      [businessId, rivalBusinessId].map(async (business) => {
        const [row] = await db<{ id: string }[]>`
          select id from locations where business_id=${business} order by created_at limit 1
        `;
        return row!.id;
      })
    ) as [string, string];

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
      values (${businessId},'Terminal','Client') returning id
    `;
    customerId = customer!.id;
    const [pet] = await db<{ id: string }[]>`
      insert into pets(business_id,customer_id,name) values (${businessId},${customerId},'Biscuit')
      returning id
    `;
    petId = pet!.id;
    const [employee] = await db<{ id: string }[]>`
      insert into employees(business_id,display_name) values (${businessId},'Groomer') returning id
    `;
    employeeId = employee!.id;

    // Somebody who takes money but configures nothing.
    const staffToken = crypto.randomUUID();
    const [staff] = await db<{ userId: string }[]>`
      with account as (
        insert into users(email,normalized_email,password_hash)
        values (${`terminal-staff-${suffix}@example.test`},${`terminal-staff-${suffix}@example.test`},
          ${await hashPassword("correct horse terminal staff")})
        returning id
      )
      insert into business_memberships(business_id,user_id,permissions)
      select ${businessId},id,array['checkout.perform','payments.view'] from account
      returning user_id
    `;
    await db`
      insert into sessions(user_id,token_hash,expires_at)
      values (${staff!.userId},${tokenHash(staffToken)},now()+interval '1 day')
    `;
    staffCookie = `pawsh_session=${staffToken}`;

    await connect(ownerCookie);
  });

  afterAll(async () => { await app.close(); await db.end(); });

  // ---------------------------------------------------------------------------
  // Phase D - pairing
  // ---------------------------------------------------------------------------

  it("records the Square card processor on connect, so the tip presets live in one place", async () => {
    const [processor] = await db<{ tipPercent1: number; isDefault: boolean }[]>`
      select tip_percent_1, is_default from card_processors
      where business_id=${businessId} and provider='square'
    `;
    expect(processor).toBeDefined();
    expect(processor!.isDefault).toBe(true);
  });

  it("offers the merchant's locations live, and marks the ones this salon cannot invoice in", async () => {
    const withForeignLocation = squareStub({
      merchantId,
      locations: [
        { id: "LSAMPLE000000001", name: "Front Counter", status: "ACTIVE", currency: "USD", timezone: "UTC" },
        { id: "LFOREIGN00000001", name: "Toronto", status: "ACTIVE", currency: "CAD", timezone: "UTC" }
      ]
    });
    const scoped = await createApp(config, db, {
      runWorker: false, serveStatic: false, squareClient: withForeignLocation.client
    });
    await scoped.ready();
    try {
      const listed = await scoped.inject({
        method: "GET", url: "/api/integrations/square/locations", headers: { cookie: ownerCookie }
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().locations).toEqual([
        expect.objectContaining({ id: "LSAMPLE000000001", usable: true }),
        // Offered, not hidden: an owner who can see it in Square's dashboard is told why Pawsh
        // will not take it rather than left hunting for it.
        expect.objectContaining({ id: "LFOREIGN00000001", usable: false })
      ]);

      const refused = await scoped.inject({
        method: "POST", url: "/api/integrations/square/devices", headers: { cookie: ownerCookie },
        payload: { locationId, squareLocationId: "LFOREIGN00000001", label: "Toronto counter" }
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe("SQUARE_LOCATION_CURRENCY");
    } finally {
      await scoped.close();
    }
  });

  it("refuses a Square location the connected merchant does not own", async () => {
    const refused = await app.inject({
      method: "POST", url: "/api/integrations/square/devices", headers: { cookie: ownerCookie },
      payload: { locationId, squareLocationId: "LSOMEBODYELSE001", label: "Not ours" }
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("SQUARE_LOCATION_UNKNOWN");
  });

  it("refuses a device pointed at another salon's location", async () => {
    const refused = await app.inject({
      method: "POST", url: "/api/integrations/square/devices", headers: { cookie: ownerCookie },
      payload: { locationId: rivalLocationId, squareLocationId: "LSAMPLE000000001", label: "Stolen" }
    });
    expect(refused.statusCode).toBe(404);
  });

  it("issues a pairing code, pairs it from the webhook, and never returns a Square identifier", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/integrations/square/devices", headers: { cookie: ownerCookie },
      payload: { locationId, squareLocationId: "LSAMPLE000000001", label: "Webhook counter" }
    });
    expect(created.statusCode).toBe(201);
    const device = created.json();
    expect(device.pairingStatus).toBe("expired");
    // A screen has no use for a Square device or location id, and a value a client holds is a
    // value a client can send back.
    expect(JSON.stringify(device)).not.toContain("LSAMPLE000000001");

    const issued = await app.inject({
      method: "POST", url: `/api/integrations/square/devices/${device.id}/code`,
      headers: { cookie: ownerCookie }
    });
    expect(issued.statusCode).toBe(200);
    expect(issued.json().pairingStatus).toBe("unpaired");
    expect(issued.json().pairingCode).toMatch(/^PW[0-9A-F]{4}\d{2}$/);

    const [row] = await db<{ deviceCodeId: string }[]>`
      select device_code_id from square_devices where id=${device.id}
    `;
    const paired = square.pairDeviceCode({
      deviceCodeId: row!.deviceCodeId, deviceId: "DEVICEWEBHOOK001"
    });
    const body = Buffer.from(JSON.stringify({
      merchant_id: merchantId, type: "device.code.paired", event_id: crypto.randomUUID(),
      data: { type: "device_code.paired", id: paired.id, object: { device_code: paired } }
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
    await drain();

    const read = await app.inject({
      method: "GET", url: "/api/integrations/square", headers: { cookie: ownerCookie }
    });
    const listed = read.json().devices.find((entry: { id: string }) => entry.id === device.id);
    expect(listed.pairingStatus).toBe("paired");
    expect(listed.pairingCode).toBeNull();
    expect(JSON.stringify(listed)).not.toContain("DEVICEWEBHOOK001");
  });

  it("presents an expired code as expired and lets a fresh one be issued", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/integrations/square/devices", headers: { cookie: ownerCookie },
      payload: { locationId, squareLocationId: "LSAMPLE000000001", label: "Expiring counter" }
    });
    const deviceId = created.json().id as string;
    await app.inject({
      method: "POST", url: `/api/integrations/square/devices/${deviceId}/code`,
      headers: { cookie: ownerCookie }
    });
    // The moment `pair_by` passes, the code stops working. The column still says `unpaired`
    // because the sweep has not run, and the screen must not repeat that.
    await db`update square_devices set pair_by=now()-interval '1 second' where id=${deviceId}`;

    const read = await app.inject({
      method: "GET", url: "/api/integrations/square", headers: { cookie: ownerCookie }
    });
    const stale = read.json().devices.find((entry: { id: string }) => entry.id === deviceId);
    expect(stale.pairingStatus).toBe("expired");
    expect(stale.pairingCode).toBeNull();

    expect(await expireStaleDeviceCodes(db)).toBeGreaterThanOrEqual(1);
    const [swept] = await db<{ pairingStatus: string }[]>`
      select pairing_status from square_devices where id=${deviceId}
    `;
    expect(swept!.pairingStatus).toBe("expired");

    // Never a silently dead row: a new code can always be issued against the same terminal.
    const reissued = await app.inject({
      method: "POST", url: `/api/integrations/square/devices/${deviceId}/code`,
      headers: { cookie: ownerCookie }
    });
    expect(reissued.statusCode).toBe(200);
    expect(reissued.json().pairingStatus).toBe("unpaired");
    expect(reissued.json().pairingCode).toBeTruthy();
  });

  it("refuses every pairing route to somebody without settings.manage", async () => {
    for (const request of [
      { method: "GET" as const, url: "/api/integrations/square/locations" },
      { method: "POST" as const, url: "/api/integrations/square/devices" },
      { method: "POST" as const, url: `/api/integrations/square/devices/${crypto.randomUUID()}/code` },
      { method: "POST" as const, url: `/api/integrations/square/devices/${crypto.randomUUID()}/refresh` },
      { method: "DELETE" as const, url: `/api/integrations/square/devices/${crypto.randomUUID()}` }
    ]) {
      const response = await app.inject({
        ...request, headers: { cookie: staffCookie },
        ...(request.method === "POST" ? { payload: {} } : {})
      });
      expect(response.statusCode, request.url).toBe(403);
    }
  });

  it("keeps one salon's terminals invisible and unusable to another", async () => {
    const mine = await pairTerminal("Isolation counter");
    const rivalRead = await app.inject({
      method: "GET", url: "/api/integrations/square", headers: { cookie: rivalCookie }
    });
    expect(rivalRead.json().devices).toEqual([]);
    const stolen = await app.inject({
      method: "POST", url: `/api/integrations/square/devices/${mine.deviceId}/code`,
      headers: { cookie: rivalCookie }
    });
    expect(stolen.statusCode).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Phase E - starting a checkout
  // ---------------------------------------------------------------------------

  it("derives the amount from the invoice and refuses to be told one", async () => {
    const { deviceId } = await pairTerminal("Amount counter");
    const invoice = await terminalInvoice();
    const started = await app.inject({
      method: "POST", url: `/api/invoices/${invoice.id}/terminal-checkouts`,
      headers: { cookie: ownerCookie },
      // A client that wants to charge a different amount has nowhere to say so: the field is not
      // in the schema, and the amount is read from the invoice under a lock.
      payload: { deviceId, amountMinor: 1, currency: "CAD" }
    });
    expect(started.statusCode, started.body).toBe(201);
    expect(started.json().amountMinor).toBe(invoice.balanceMinor);
    expect(started.json().currency).toBe("USD");

    const sent = square.state.calls.filter((call) => call.method === "createTerminalCheckout").at(-1);
    expect((sent!.input as { amountMinor: number }).amountMinor).toBe(invoice.balanceMinor);
    // `reference_id` is reconciliation metadata and Square caps it at 40 characters.
    expect((sent!.input as { referenceId: string }).referenceId).toBe(invoice.id);
    expect((sent!.input as { referenceId: string }).referenceId.length).toBeLessThanOrEqual(40);
    // The salon's own three numbers, pushed to the device.
    expect((sent!.input as { tipPercentages: number[] }).tipPercentages).toEqual([15, 18, 20]);
  });

  it("derives the idempotency key, and a retry reuses it rather than charging twice", async () => {
    const { deviceId } = await pairTerminal("Retry counter");
    const invoice = await terminalInvoice();

    const first = await startCapture(invoice.id, deviceId);
    expect(first.statusCode).toBe(201);
    const checkoutId = first.json().id as string;
    const row = await checkoutRow(checkoutId);

    // Derivable from the row alone, with no clock and no randomness in it.
    expect(row.idempotencyKey).toBe(terminalCheckoutIdempotencyKey({
      businessId, invoiceId: invoice.id, deviceId,
      amountMinor: row.amountMinor, currency: "USD", attempt: row.attempt
    }));
    expect(row.idempotencyKey.length).toBeLessThanOrEqual(45);

    // The retry: same invoice, same device, and the response to the first request may as well
    // have been lost. It must find the same row, send the same key, and get the same checkout.
    const before = square.state.checkouts.size;
    const second = await startCapture(invoice.id, deviceId);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(checkoutId);
    expect(square.state.checkouts.size).toBe(before);

    const [countRows] = await db<{ count: number }[]>`
      select count(*)::int as count from square_terminal_checkouts
      where business_id=${businessId} and invoice_id=${invoice.id}
    `;
    expect(countRows!.count).toBe(1);
  });

  it("re-sends the same key when the first attempt never learned Square's answer", async () => {
    const { deviceId } = await pairTerminal("Lost response counter");
    const invoice = await terminalInvoice();

    // The request reaches Square and the response is lost on the way back. Square has made the
    // checkout; we have a row with a key and no checkout id.
    square.state.failNext.set("createTerminalCheckout",
      new SquareApiError("timeout", "Square did not answer within the request timeout", null));
    const lost = await startCapture(invoice.id, deviceId);
    expect(lost.statusCode).toBe(503);
    expect(lost.json().code).toBe("SQUARE_TERMINAL_UNAVAILABLE");
    const checkoutId = lost.json().checkout.id as string;
    const parked = await checkoutRow(checkoutId);
    // Still live, so pressing the button again is a retry rather than a second request.
    expect(parked.status).toBe("pending");
    expect(parked.squareCheckoutId).toBeNull();
    expect(parked.lastError).toContain("Nothing was charged");

    const retried = await startCapture(invoice.id, deviceId);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().id).toBe(checkoutId);
    const keysSent = square.state.calls
      .filter((call) => call.method === "createTerminalCheckout")
      .map((call) => (call.input as { idempotencyKey: string }).idempotencyKey);
    expect(keysSent.at(-1)).toBe(parked.idempotencyKey);
  });

  it("refuses a terminal capture on an invoice that already carries a tip", async () => {
    const { deviceId } = await pairTerminal("Tipped counter");
    const invoice = await terminalInvoice();
    await db`
      update invoices set tip_minor=500, total_minor=total_minor+500, balance_minor=balance_minor+500
      where business_id=${businessId} and id=${invoice.id}
    `;
    const refused = await startCapture(invoice.id, deviceId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("INVOICE_HAS_TIP");
  });

  it("refuses a terminal that is not paired, and one that belongs to another salon", async () => {
    const invoice = await terminalInvoice();
    const unpaired = await app.inject({
      method: "POST", url: "/api/integrations/square/devices", headers: { cookie: ownerCookie },
      payload: { locationId, squareLocationId: "LSAMPLE000000001", label: "Never paired" }
    });
    const refused = await startCapture(invoice.id, unpaired.json().id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("SQUARE_DEVICE_NOT_PAIRED");

    const alien = await startCapture(invoice.id, crypto.randomUUID());
    expect(alien.statusCode).toBe(409);
    expect(alien.json().code).toBe("SQUARE_DEVICE_NOT_PAIRED");
  });

  // ---------------------------------------------------------------------------
  // Phase F - reconciliation
  // ---------------------------------------------------------------------------

  it("posts the tip the customer left, in one transaction, and lands the balance at zero", async () => {
    const { deviceId } = await pairTerminal("Tip counter");
    const invoice = await terminalInvoice();
    const before = await invoiceRow(invoice.id);
    expect(before.tipMinor).toBe(0);

    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    const squareCheckoutId = (await checkoutRow(checkoutId)).squareCheckoutId!;

    // Nothing may say paid before the Payment has been read and posted.
    expect(started.json().settled).toBe(false);
    expect(started.json().tipMinor).toBeNull();
    expect(started.json().label).toBe("Waiting for the customer");

    const payment = square.completeCheckout({
      checkoutId: squareCheckoutId, amountMinor: before.balanceMinor, tipMinor: 1000
    });
    await terminalWebhook(squareCheckoutId);
    await drain();

    const after = await invoiceRow(invoice.id);
    // The invoice's own components still add up, and the tip is what the customer actually left.
    expect(after.tipMinor).toBe(1000);
    expect(after.totalMinor).toBe(before.totalMinor + 1000);
    expect(after.subtotalMinor - after.discountMinor + after.taxMinor + after.tipMinor)
      .toBe(after.totalMinor);
    expect(after.balanceMinor).toBe(0);
    expect(after.status).toBe("paid");

    const posted = await squarePayments(invoice.id);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.amountMinor).toBe(before.balanceMinor + 1000);
    expect(posted[0]!.providerTipMinor).toBe(1000);
    expect(posted[0]!.providerPaymentId).toBe(payment.id);
    expect(posted[0]!.method).toBe("external_card");

    const settled = await checkoutRow(checkoutId);
    expect(settled.status).toBe("completed");
    expect(settled.paymentId).toBe(posted[0]!.id);
    expect(settled.reconciledAt).not.toBeNull();

    const [audits] = await db<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where business_id=${businessId} and resource_id=${checkoutId}
        and action='integration.square.checkout.reconciled'
    `;
    expect(audits!.count).toBe(1);
  });

  it("converges on one payment across a replay, a duplicate payment id and a manual refresh", async () => {
    const { deviceId } = await pairTerminal("Replay counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    const squareCheckoutId = (await checkoutRow(checkoutId)).squareCheckoutId!;

    const payment = square.completeCheckout({
      checkoutId: squareCheckoutId, amountMinor: invoice.balanceMinor, tipMinor: 250
    });
    // Square repeating itself inside one checkout is not two payments.
    const stored = square.state.checkouts.get(squareCheckoutId)!;
    square.state.checkouts.set(squareCheckoutId, {
      ...stored, payment_ids: [payment.id, payment.id]
    });

    await terminalWebhook(squareCheckoutId);
    await drain();
    // The same event again, and again, exactly as Square retries it.
    await terminalWebhook(squareCheckoutId);
    await terminalWebhook(squareCheckoutId);
    await drainUntilQuiet();
    // And an operator pressing refresh at the same time.
    const refreshed = await app.inject({
      method: "POST", url: `/api/square/terminal-checkouts/${checkoutId}/refresh`,
      headers: { cookie: ownerCookie }
    });
    expect(refreshed.statusCode).toBe(200);

    const posted = await squarePayments(invoice.id);
    expect(posted).toHaveLength(1);
    const after = await invoiceRow(invoice.id);
    expect(after.tipMinor).toBe(250);
    expect(after.balanceMinor).toBe(0);
    expect(after.totalMinor).toBe(invoice.totalMinor + 250);
  });

  it("lets Square win when a cancelled checkout turns out to have completed", async () => {
    const { deviceId } = await pairTerminal("Cancel race counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    const squareCheckoutId = (await checkoutRow(checkoutId)).squareCheckoutId!;

    square.cancelCheckout({ checkoutId: squareCheckoutId, reason: "CANCELED_BY_SELLER" });
    await terminalWebhook(squareCheckoutId);
    await drain();
    expect((await checkoutRow(checkoutId)).status).toBe("canceled");
    expect(await invoiceRow(invoice.id)).toMatchObject({ balanceMinor: invoice.balanceMinor });

    // The card had already gone through. Square is the authority, and there is still one payment.
    square.completeCheckout({
      checkoutId: squareCheckoutId, amountMinor: invoice.balanceMinor, tipMinor: 0
    });
    await terminalWebhook(squareCheckoutId);
    await drainUntilQuiet();

    expect((await checkoutRow(checkoutId)).status).toBe("completed");
    expect(await squarePayments(invoice.id)).toHaveLength(1);
    expect((await invoiceRow(invoice.id)).balanceMinor).toBe(0);
  });

  it("cancels through Square, and never writes cancelled on its own authority", async () => {
    const { deviceId } = await pairTerminal("Cancel counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;

    const cancelled = await app.inject({
      method: "POST", url: `/api/square/terminal-checkouts/${checkoutId}/cancel`,
      headers: { cookie: ownerCookie }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("canceled");
    expect(cancelled.json().label).toBe("Cancelled");
    expect(cancelled.json().settled).toBe(false);
    expect((await invoiceRow(invoice.id)).balanceMinor).toBe(invoice.balanceMinor);
    expect(await squarePayments(invoice.id)).toHaveLength(0);

    // The next attempt is a new attempt, with a new key rather than the cancelled one.
    const again = await startCapture(invoice.id, deviceId);
    expect(again.statusCode).toBe(201);
    expect(again.json().id).not.toBe(checkoutId);
    expect(again.json().attempt).toBe(2);
    const first = await checkoutRow(checkoutId);
    const next = await checkoutRow(again.json().id);
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("reports a timed-out terminal as timed out rather than as somebody's decision", async () => {
    const { deviceId } = await pairTerminal("Timeout counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    const squareCheckoutId = (await checkoutRow(checkoutId)).squareCheckoutId!;

    square.cancelCheckout({ checkoutId: squareCheckoutId, reason: "TIMED_OUT" });
    await terminalWebhook(squareCheckoutId);
    await drain();

    const read = await app.inject({
      method: "GET", url: `/api/square/terminal-checkouts/${checkoutId}`,
      headers: { cookie: ownerCookie }
    });
    expect(read.json()).toMatchObject({
      status: "canceled", cancelReason: "TIMED_OUT", label: "Timed out", settled: false
    });
    expect((await invoiceRow(invoice.id)).balanceMinor).toBe(invoice.balanceMinor);
  });

  it("reports a terminal that never woke up as offline, and leaves the invoice unpaid", async () => {
    const { deviceId } = await pairTerminal("Offline counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    const squareCheckoutId = (await checkoutRow(checkoutId)).squareCheckoutId!;

    square.cancelCheckout({ checkoutId: squareCheckoutId, reason: "DEVICE_OFFLINE" });
    const refreshed = await app.inject({
      method: "POST", url: `/api/square/terminal-checkouts/${checkoutId}/refresh`,
      headers: { cookie: ownerCookie }
    });
    expect(refreshed.json()).toMatchObject({
      status: "canceled", label: "Terminal offline", settled: false
    });
    expect((await invoiceRow(invoice.id)).status).toBe("open");
  });

  it("recovers a checkout whose webhook never arrived, from the operator's refresh alone", async () => {
    const { deviceId } = await pairTerminal("Silent counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    const squareCheckoutId = (await checkoutRow(checkoutId)).squareCheckoutId!;

    square.completeCheckout({
      checkoutId: squareCheckoutId, amountMinor: invoice.balanceMinor, tipMinor: 500
    });
    // No webhook at all. The row would otherwise sit pending forever.
    await db`update square_terminal_checkouts set created_at=now()-interval '1 hour' where id=${checkoutId}`;

    const refreshed = await app.inject({
      method: "POST", url: `/api/square/terminal-checkouts/${checkoutId}/refresh`,
      headers: { cookie: ownerCookie }
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ status: "completed", settled: true, tipMinor: 500 });
    expect((await invoiceRow(invoice.id)).balanceMinor).toBe(0);
    expect(await squarePayments(invoice.id)).toHaveLength(1);
  });

  it("refreshes an expired token mid-flight and retries once with the same key", async () => {
    const { deviceId } = await pairTerminal("Expiry counter");
    const invoice = await terminalInvoice();
    const refreshesBefore = square.state.refreshes;

    square.state.failNext.set("createTerminalCheckout",
      new SquareApiError("access_token_expired", "The access token has expired", 401));
    const started = await startCapture(invoice.id, deviceId);
    expect(started.statusCode, started.body).toBe(201);
    expect(square.state.refreshes).toBe(refreshesBefore + 1);

    const attempts = square.state.calls
      .filter((call) => call.method === "createTerminalCheckout")
      .slice(-2)
      .map((call) => (call.input as { idempotencyKey: string }).idempotencyKey);
    // Byte for byte the same request, which is why the retry is safe: Square answers the repeated
    // key with the checkout it already made rather than a second prompt to tap a card.
    expect(attempts[0]).toBe(attempts[1]);
    expect((await checkoutRow(started.json().id)).squareCheckoutId).not.toBeNull();
  });

  it("resolves a checkout as failed when the authorisation is revoked mid-flight", async () => {
    const { deviceId } = await pairTerminal("Revoked counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    const squareCheckoutId = (await checkoutRow(checkoutId)).squareCheckoutId!;

    square.state.failAlways.set("retrieveTerminalCheckout",
      new SquareApiError("access_token_revoked", "The merchant revoked this authorization", 401));
    try {
      await terminalWebhook(squareCheckoutId);
      await drain();
    } finally {
      square.state.failAlways.delete("retrieveTerminalCheckout");
    }

    const failed = await checkoutRow(checkoutId);
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toContain("revoked");
    // No success is shown for money nobody can confirm moved, and the invoice is untouched.
    expect((await invoiceRow(invoice.id)).status).toBe("open");
    expect(await squarePayments(invoice.id)).toHaveLength(0);
    const [connection] = await db<{ status: string }[]>`
      select status from square_connections where business_id=${businessId}
    `;
    expect(connection!.status).toBe("revoked");

    // Put the salon back together for the tests that follow.
    await connect(ownerCookie);
  });

  it("parks a mismatch for a person instead of coercing the amount", async () => {
    const { deviceId } = await pairTerminal("Mismatch counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    const squareCheckoutId = (await checkoutRow(checkoutId)).squareCheckoutId!;

    // The terminal took less than it was asked for. There is no arithmetic that makes this right.
    square.completeCheckout({
      checkoutId: squareCheckoutId, amountMinor: invoice.balanceMinor - 100, tipMinor: 0
    });
    await terminalWebhook(squareCheckoutId);
    await drain();

    const review = await checkoutRow(checkoutId);
    expect(review.status).toBe("needs_review");
    expect(review.paymentId).toBeNull();
    const mismatch = JSON.parse(review.mismatchText!);
    // Both sides, as Square's own vocabulary rather than camel-cased by the jsonb read.
    expect(mismatch.reason).toBe("amount");
    expect(mismatch.expected).toBe(invoice.balanceMinor);
    expect(mismatch.received).toBe(invoice.balanceMinor - 100);

    expect((await invoiceRow(invoice.id)).status).toBe("open");
    expect(await squarePayments(invoice.id)).toHaveLength(0);

    const read = await app.inject({
      method: "GET", url: `/api/square/terminal-checkouts/${checkoutId}`,
      headers: { cookie: ownerCookie }
    });
    expect(read.json()).toMatchObject({
      label: "Needs review", needsReview: true, settled: false, tipMinor: null
    });
  });

  it("parks a mismatch when the invoice moved while the card was in the reader", async () => {
    const { deviceId } = await pairTerminal("Moved invoice counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    const squareCheckoutId = (await checkoutRow(checkoutId)).squareCheckoutId!;

    // Somebody took cash at the same moment.
    const paid = await app.inject({
      method: "POST", url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        amountMinor: 500, expectedBalanceMinor: invoice.balanceMinor, method: "cash"
      }
    });
    expect(paid.statusCode).toBe(201);

    square.completeCheckout({
      checkoutId: squareCheckoutId, amountMinor: invoice.balanceMinor, tipMinor: 0
    });
    await terminalWebhook(squareCheckoutId);
    await drain();

    const review = await checkoutRow(checkoutId);
    expect(review.status).toBe("needs_review");
    expect(JSON.parse(review.mismatchText!).reason).toBe("invoice_balance");
    expect(await squarePayments(invoice.id)).toHaveLength(0);
    // The cash payment is untouched, which is the point: a Terminal mismatch never rewrites a
    // ledger entry somebody else made.
    expect((await invoiceRow(invoice.id)).balanceMinor).toBe(invoice.balanceMinor - 500);
  });

  it("fails rather than posts when the terminal finished without a completed payment", async () => {
    const { deviceId } = await pairTerminal("Declined counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    const squareCheckoutId = (await checkoutRow(checkoutId)).squareCheckoutId!;

    square.completeCheckout({
      checkoutId: squareCheckoutId, amountMinor: invoice.balanceMinor, tipMinor: 0,
      paymentStatus: "FAILED"
    });
    await terminalWebhook(squareCheckoutId);
    await drain();

    const failed = await checkoutRow(checkoutId);
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toContain("FAILED");
    expect((await invoiceRow(invoice.id)).status).toBe("open");
    expect(await squarePayments(invoice.id)).toHaveLength(0);
  });

  it("parks a webhook that arrives before our own row commits, then reconciles it", async () => {
    const { deviceId } = await pairTerminal("Race counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    const squareCheckoutId = (await checkoutRow(checkoutId)).squareCheckoutId!;

    // The state the race produces: Square notifies about a checkout whose binding to our row has
    // not landed yet. Nothing may be dropped, and nothing may be invented.
    await db`update square_terminal_checkouts set square_checkout_id=null where id=${checkoutId}`;
    square.completeCheckout({
      checkoutId: squareCheckoutId, amountMinor: invoice.balanceMinor, tipMinor: 0
    });
    const eventId = await terminalWebhook(squareCheckoutId);
    await drain();

    const [waiting] = await db<{ status: string; processedAt: Date | null }[]>`
      select status, processed_at from square_webhook_events where event_id=${eventId}
    `;
    expect(waiting!.status).toBe("failed");
    expect(waiting!.processedAt).toBeNull();
    expect(await squarePayments(invoice.id)).toHaveLength(0);

    // The commit lands, the retry finds the row, and the payment posts exactly once.
    await db`update square_terminal_checkouts set square_checkout_id=${squareCheckoutId} where id=${checkoutId}`;
    await db`update square_webhook_events set next_attempt_at=now() where event_id=${eventId}`;
    await drain();

    const [settled] = await db<{ status: string; businessId: string | null }[]>`
      select status, business_id from square_webhook_events where event_id=${eventId}
    `;
    expect(settled!.status).toBe("processed");
    expect(settled!.businessId).toBe(businessId);
    expect(await squarePayments(invoice.id)).toHaveLength(1);
    expect((await invoiceRow(invoice.id)).balanceMinor).toBe(0);
  });

  it("never posts a payment the salon took outside Pawsh on its own Square account", async () => {
    const body = await readFile("tests/fixtures/square/webhook-payment-updated.json");
    const eventId = JSON.parse(body.toString("utf8")).event_id as string;
    await db`delete from square_webhook_events where event_id=${eventId}`;
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
    await drainUntilQuiet();

    const [row] = await db<{ status: string; businessId: string | null }[]>`
      select status, business_id from square_webhook_events where event_id=${eventId}
    `;
    expect(row!.status).toBe("parked");
    expect(row!.businessId).toBeNull();
    const [posts] = await db<{ count: number }[]>`
      select count(*)::int as count from payments where provider='square'
        and provider_payment_id='PAYSAMPLE00000001' and business_id=${businessId}
    `;
    expect(posts!.count).toBe(0);
  });

  it("keeps one salon's checkouts unreachable from another", async () => {
    const { deviceId } = await pairTerminal("Tenant counter");
    const invoice = await terminalInvoice();
    const started = await startCapture(invoice.id, deviceId);
    const checkoutId = started.json().id as string;
    for (const request of [
      { method: "GET" as const, url: `/api/square/terminal-checkouts/${checkoutId}` },
      { method: "POST" as const, url: `/api/square/terminal-checkouts/${checkoutId}/refresh` },
      { method: "POST" as const, url: `/api/square/terminal-checkouts/${checkoutId}/cancel` }
    ]) {
      const response = await app.inject({ ...request, headers: { cookie: rivalCookie } });
      expect(response.statusCode, request.url).toBe(404);
    }
  });

  it("shows a groomer only the terminals they may use, and nothing about the account", async () => {
    const read = await app.inject({
      method: "GET", url: "/api/checkout/terminal", headers: { cookie: staffCookie }
    });
    expect(read.statusCode).toBe(200);
    const payload = read.json();
    expect(payload.available).toBe(true);
    expect(payload.devices.length).toBeGreaterThan(0);
    for (const device of payload.devices) expect(Object.keys(device).sort()).toEqual(["id", "label"]);
    // No merchant, no scopes, no location, no Square device id.
    expect(JSON.stringify(payload)).not.toContain(merchantId);
    expect(JSON.stringify(payload)).not.toContain("LSAMPLE000000001");
  });
});
