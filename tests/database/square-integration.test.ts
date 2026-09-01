import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { tokenHash } from "../../src/http/context.js";
import { hashPassword } from "../../src/security/passwords.js";
import { IntegrationKeyring } from "../../src/security/integration-encryption.js";
import { squareStub } from "../support/square-stub.js";
import {
  hashOAuthState, openAccessToken, refreshDueConnections, storeConnection
} from "../../src/integrations/square/oauth.js";
import { SquareApiError } from "../../src/integrations/square/errors.js";
import { roleFor } from "../support/roles.js";
import {
  processSquareWebhooks, squareSignature, squareSignatureHeader
} from "../../src/integrations/square/webhooks.js";

/**
 * Square, against a real database.
 *
 * The unit suite holds the arithmetic - signatures, sealing, state decisions, error mapping. This
 * file holds the things only PostgreSQL can prove: that a tenant boundary is a boundary, that the
 * indexes refuse what application code would race on, and that row-level security is actually
 * enabled on every table this integration added.
 *
 * The important one is the partial unique index on `payments`. Square retries a webhook about
 * eleven times over twenty-four hours, so "post this payment" will arrive more than once, and a
 * check-then-insert in application code loses that race by construction. Here the second posting
 * of one Square payment is refused by the database, under concurrency, whichever path got there
 * first.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const integrationKey = randomBytes(32).toString("base64");
const webhookSignatureKey = randomBytes(32).toString("base64");
const notificationUrl = "http://localhost:3000/webhooks/square";

const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "square-integration-test-secret-at-least-32-chars",
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

const merchantId = "MLSAMPLE00000001";
const accessToken = "EAAAl0SAMPLEsandboxACCESStoken0000000000000000000000";
const refreshToken = "EQAAl0SAMPLEsandboxREFRESHtoken000000000000000000000";

/** Fixture-shaped, so no test in this file can reach the network. */
const square = squareStub({ merchantId });

function cookie(response: { headers: Record<string, unknown> }): string {
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

describeDatabase("Square Terminal integration", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string;
  let rivalCookie: string;
  let staffCookie: string;
  let businessId: string;
  let rivalBusinessId: string;
  let locationId: string;
  let rivalLocationId: string;
  const suffix = crypto.randomUUID();

  /** A business of its own, so a refresh test cannot disturb the connection the others share. */
  async function freshBusiness(label: string): Promise<string> {
    const created = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `${label}-${suffix}@example.test`,
        password: "correct horse another salon", businessName: `Salon ${label}`
      }
    });
    return created.json().businessId as string;
  }

  async function connect(withCookie: string): Promise<string> {
    const started = await app.inject({
      method: "POST", url: "/api/integrations/square/connect", headers: { cookie: withCookie }
    });
    expect(started.statusCode).toBe(200);
    return new URL(started.json().authorizeUrl).searchParams.get("state")!;
  }

  async function completeConnection(withCookie: string, state: string) {
    return app.inject({
      method: "GET",
      url: `/api/integrations/square/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: withCookie }
    });
  }

  /** The worker's Square drain, with the same dependencies `createApp` gives it. */
  async function drain(): Promise<number> {
    return processSquareWebhooks(db, {
      client: square.client, keyring, environment: "sandbox"
    });
  }

  async function postWebhook(body: Buffer, options: { signature?: string } = {}) {
    return app.inject({
      method: "POST", url: "/webhooks/square", payload: body,
      headers: {
        "content-type": "application/json",
        [squareSignatureHeader]: options.signature
          ?? squareSignature({ notificationUrl, rawBody: body, signatureKey: webhookSignatureKey })
      }
    });
  }

  beforeAll(async () => {
    db = createDatabase(config);
    // The fixtures carry fixed Square identifiers, and the test database is reused between runs.
    // Clearing the rows a previous run left behind keeps the event ids and the device code
    // unique-per-run properties they are asserted on, without editing the recorded bytes.
    await db`
      delete from square_webhook_events where event_id in (
        '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'
      )
    `;
    await db`delete from square_devices where device_code_id='DCSAMPLE00000001'`;
    app = await createApp(config, db, {
      runWorker: false, serveStatic: false, squareClient: square.client
    });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `salon-square-${suffix}@example.test`,
        password: "correct horse salon square", businessName: "Salon Square"
      }
    });
    ownerCookie = cookie(signup);
    businessId = signup.json().businessId;

    const rival = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `rival-square-${suffix}@example.test`,
        password: "correct horse rival square", businessName: "Rival Square"
      }
    });
    rivalCookie = cookie(rival);
    rivalBusinessId = rival.json().businessId;

    [locationId, rivalLocationId] = await Promise.all([businessId, rivalBusinessId].map(
      async (business) => {
        const [row] = await db<{ id: string }[]>`
          select id from locations where business_id=${business} order by created_at limit 1
        `;
        return row!.id;
      }
    )) as [string, string];

    // Somebody who takes money but configures nothing: connecting a payment processor is a
    // settings act, and `checkout.perform` is not it.
    const staffToken = crypto.randomUUID();
    const [staff] = await db<{ userId: string }[]>`
      with account as (
        insert into users(email,normalized_email,password_hash)
        values (${`staff-square-${suffix}@example.test`},${`staff-square-${suffix}@example.test`},
          ${await hashPassword("correct horse salon staff")})
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
    staffCookie = `pawsh_session=${staffToken}`;
  });

  afterAll(async () => { await app.close(); await db.end(); });

  // ---------------------------------------------------------------------------
  // Row-level security
  // ---------------------------------------------------------------------------

  it("enables row-level security and a tenant_isolation policy on every table it adds", async () => {
    const tables = [
      "square_connections", "square_oauth_states", "square_devices",
      "square_terminal_checkouts", "square_webhook_events"
    ];
    const rows = await db<{ relname: string; relrowsecurity: boolean; policies: number }[]>`
      select c.relname, c.relrowsecurity,
        (select count(*)::int from pg_policies p
          where p.schemaname='public' and p.tablename=c.relname and p.policyname='tenant_isolation') as policies
      from pg_class c
      join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
      where c.relname in ${db(tables)}
      order by c.relname
    `;
    expect(rows.map((row) => row.relname)).toEqual([...tables].sort());
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.policies, row.relname).toBe(1);
    }
  });

  /**
   * The webhook inbox is the one table here whose rows arrive before their tenant is known, and
   * that is exactly what makes its policy easy to get wrong. An unconditional "or business_id is
   * null" arm would let any salon's session read every unresolved row in the table - other
   * merchants' ids, device codes, `pair_by`, and the raw payloads - which is a cross-tenant read
   * however temporary the rows are.
   *
   * So the axis is the CONTEXT. With no `app.business_id` this is the system's inbox and both the
   * receiver and the drain can work in it; with `app.business_id` set, ordinary equality applies
   * and nothing else is visible. Exercised through a real non-owner role, because the application
   * role owns these tables and therefore bypasses RLS entirely.
   */
  it("never shows one salon another's pending webhook rows, and still lets the system resolve them", async () => {
    const pendingEvent = crypto.randomUUID();
    const mineEvent = crypto.randomUUID();
    const rivalEvent = crypto.randomUUID();
    await db`
      insert into square_webhook_events (event_id, merchant_id, business_id, event_type, payload)
      values
        (${pendingEvent}, 'MOTHERMERCHANT01', null, 'payment.updated', '{"secret":"other merchant"}'::jsonb),
        (${mineEvent}, ${merchantId}, ${businessId}, 'payment.updated', '{}'::jsonb),
        (${rivalEvent}, 'MRIVALMERCHANT01', ${rivalBusinessId}, 'payment.updated', '{}'::jsonb)
    `;
    await db.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname='pawsh_square_rls_test') then
          create role pawsh_square_rls_test nologin nosuperuser nobypassrls;
        end if;
      end $$;
      grant usage on schema public to pawsh_square_rls_test;
      grant select,insert,update,delete on square_webhook_events to pawsh_square_rls_test;
    `);

    // A salon session: its own resolved rows, and nothing else.
    await db.begin(async (tx) => {
      await tx`set local role pawsh_square_rls_test`;
      await tx`select set_config('app.business_id',${businessId},true)`;
      const visible = await tx<{ eventId: string }[]>`
        select event_id from square_webhook_events
        where event_id in (${pendingEvent},${mineEvent},${rivalEvent})
      `;
      expect(visible.map((row) => row.eventId)).toEqual([mineEvent]);

      // The unresolved row is not merely filtered out of a listing - it cannot be reached at all.
      const targeted = await tx<{ payload: unknown }[]>`
        select payload from square_webhook_events where event_id=${pendingEvent}
      `;
      expect(targeted).toHaveLength(0);

      // Nor may a tenant session park a row outside every other tenant's view.
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint`
          insert into square_webhook_events (event_id, merchant_id, business_id, event_type, payload)
          values (${crypto.randomUUID()}, 'MSNEAK0000000001', null, 'payment.updated', '{}'::jsonb)
        `;
      })).rejects.toThrow();
      // Nor claim another business's row.
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint`
          insert into square_webhook_events (event_id, merchant_id, business_id, event_type, payload)
          values (${crypto.randomUUID()}, 'MSNEAK0000000001', ${rivalBusinessId}, 'payment.updated', '{}'::jsonb)
        `;
      })).rejects.toThrow();
    });

    // The receiver and the drain, which run with no tenant context because they are the system
    // rather than a salon: write the row, read it back, and fill the tenant in afterwards. That
    // last write is what a policy phrased as "null rows only, when there is no tenant" refuses,
    // because the new row has a business id while the session still has none.
    const receivedEvent = crypto.randomUUID();
    await db.begin(async (tx) => {
      await tx`set local role pawsh_square_rls_test`;
      await tx`
        insert into square_webhook_events (event_id, merchant_id, event_type, payload)
        values (${receivedEvent}, 'MSYSTEM000000001', 'device.code.paired', '{}'::jsonb)
      `;
      const claimable = await tx<{ eventId: string }[]>`
        select event_id from square_webhook_events where event_id=${receivedEvent}
      `;
      expect(claimable).toHaveLength(1);
      const resolved = await tx<{ eventId: string }[]>`
        update square_webhook_events set business_id=${businessId}, status='processed', processed_at=now()
        where event_id=${receivedEvent} returning event_id
      `;
      expect(resolved).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Permission and configuration honesty
  // ---------------------------------------------------------------------------

  it("refuses every Square route to somebody without settings.manage", async () => {
    for (const request of [
      { method: "GET" as const, url: "/api/integrations/square" },
      { method: "POST" as const, url: "/api/integrations/square/connect" },
      { method: "POST" as const, url: "/api/integrations/square/disconnect" },
      { method: "GET" as const, url: "/api/integrations/square/callback?code=x&state=y" }
    ]) {
      const response = await app.inject({ ...request, headers: { cookie: staffCookie } });
      expect(response.statusCode, request.url).toBe(403);
    }
  });

  it("reports what it is configured with, and never a token", async () => {
    const response = await app.inject({
      method: "GET", url: "/api/integrations/square", headers: { cookie: ownerCookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true, environment: "sandbox",
      requestedScopes: ["PAYMENTS_READ", "PAYMENTS_WRITE", "DEVICE_CREDENTIAL_MANAGEMENT", "MERCHANT_PROFILE_READ"]
    });
    expect(response.body).not.toContain("sq0csb");
  });

  // ---------------------------------------------------------------------------
  // The OAuth state
  // ---------------------------------------------------------------------------

  it("binds the state to the business that started the flow and spends it exactly once", async () => {
    const state = await connect(ownerCookie);

    // Another salon's owner presenting this state gets nothing, and - importantly - does not
    // burn it: the rightful business must still be able to finish its own connection.
    const stolen = await completeConnection(rivalCookie, state);
    expect(stolen.statusCode).toBe(303);
    expect(stolen.headers.location).toContain("square=error");
    expect(stolen.headers.location).toContain("state_business_mismatch");
    const [unspent] = await db<{ consumedAt: Date | null }[]>`
      select consumed_at from square_oauth_states where state_hash=${hashOAuthState(state)}
    `;
    expect(unspent!.consumedAt).toBeNull();
    const [rivalConnection] = await db<{ id: string }[]>`
      select id from square_connections where business_id=${rivalBusinessId}
    `;
    expect(rivalConnection).toBeUndefined();

    const connected = await completeConnection(ownerCookie, state);
    expect(connected.statusCode).toBe(303);
    expect(connected.headers.location).toContain("square=connected");

    // Replayed: the same state a second time is refused.
    const replay = await completeConnection(ownerCookie, state);
    expect(replay.headers.location).toContain("state_expired_or_used");

    // A state this server never issued is refused as unknown.
    const invented = await completeConnection(ownerCookie, randomBytes(32).toString("base64url"));
    expect(invented.headers.location).toContain("state_unknown");
  });

  it("stores the tokens sealed, bound to the business, and returns them to nobody", async () => {
    const [row] = await db<{
      accessToken: string; refreshToken: string; keyVersion: number; status: string; scopes: string[];
    }[]>`
      select access_token, refresh_token, key_version, status, scopes
      from square_connections where business_id=${businessId}
    `;
    expect(row!.status).toBe("connected");
    expect(row!.keyVersion).toBe(1);
    expect(row!.scopes).toContain("DEVICE_CREDENTIAL_MANAGEMENT");
    // Sealed, versioned, and not the token.
    expect(row!.accessToken.startsWith("v1.")).toBe(true);
    expect(row!.accessToken).not.toContain(accessToken);
    expect(row!.refreshToken).not.toContain(refreshToken);
    expect(keyring.open(row!.accessToken, {
      businessId, table: "square_connections", column: "access_token"
    })).toBe(accessToken);
    // The same ciphertext read as another business's row does not open.
    expect(() => keyring.open(row!.accessToken, {
      businessId: rivalBusinessId, table: "square_connections", column: "access_token"
    })).toThrow();

    const read = await app.inject({
      method: "GET", url: "/api/integrations/square", headers: { cookie: ownerCookie }
    });
    expect(read.body).not.toContain(accessToken);
    expect(read.body).not.toContain(refreshToken);
    expect(read.body).not.toContain("v1.");
    expect(read.json().connection).toMatchObject({ status: "connected", merchantId });
  });

  it("keeps one salon's connection invisible to another, and unchangeable by them", async () => {
    const rivalRead = await app.inject({
      method: "GET", url: "/api/integrations/square", headers: { cookie: rivalCookie }
    });
    expect(rivalRead.json().connection).toBeNull();

    const rivalDisconnect = await app.inject({
      method: "POST", url: "/api/integrations/square/disconnect", headers: { cookie: rivalCookie }
    });
    expect(rivalDisconnect.statusCode).toBe(404);
    const [after] = await db<{ status: string }[]>`
      select status from square_connections where business_id=${businessId}
    `;
    expect(after!.status).toBe("connected");
  });

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  it("refuses a device pointing at another business's location", async () => {
    await expect(db`
      insert into square_devices (business_id, location_id, square_location_id, label)
      values (${businessId}, ${rivalLocationId}, 'LSAMPLE000000001', 'Stolen Counter')
    `).rejects.toThrow();

    const [device] = await db<{ id: string }[]>`
      insert into square_devices
        (business_id, location_id, square_location_id, label, device_code_id, device_code, pair_by)
      values (${businessId}, ${locationId}, 'LSAMPLE000000001', 'Front Counter',
        'DCSAMPLE00000001', 'PAWSH1', now() + interval '5 minutes')
      returning id
    `;
    expect(device).toBeDefined();
  });

  it("refuses a device that claims to be paired without a device id", async () => {
    await expect(db`
      insert into square_devices
        (business_id, location_id, square_location_id, label, pairing_status)
      values (${businessId}, ${locationId}, 'LSAMPLE000000001', 'Unpairable', 'paired')
    `).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // The webhook receiver
  // ---------------------------------------------------------------------------

  it("rejects an unsigned or wrongly signed notification and persists nothing", async () => {
    const body = await readFile("tests/fixtures/square/webhook-terminal-checkout-updated.json");
    const eventId = JSON.parse(body.toString("utf8")).event_id as string;

    const unsigned = await app.inject({
      method: "POST", url: "/webhooks/square", payload: body,
      headers: { "content-type": "application/json" }
    });
    expect(unsigned.statusCode).toBe(401);

    const wrongKey = await postWebhook(body, {
      signature: squareSignature({
        notificationUrl, rawBody: body, signatureKey: randomBytes(32).toString("base64")
      })
    });
    expect(wrongKey.statusCode).toBe(401);

    const wrongUrl = await postWebhook(body, {
      signature: squareSignature({
        notificationUrl: "http://attacker.example/webhooks/square", rawBody: body,
        signatureKey: webhookSignatureKey
      })
    });
    expect(wrongUrl.statusCode).toBe(401);

    const [stored] = await db<{ id: string }[]>`
      select id from square_webhook_events where event_id=${eventId}
    `;
    expect(stored).toBeUndefined();
  });

  it("retries an event whose checkout it cannot resolve, then parks it rather than posting", async () => {
    const body = await readFile("tests/fixtures/square/webhook-terminal-checkout-updated.json");
    const eventId = JSON.parse(body.toString("utf8")).event_id as string;
    const accepted = await postWebhook(body);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: "recorded", eventId });

    async function claimAgain() {
      // The drain's own backoff would make this test sleep; moving the clock forward on the row
      // is the same thing without the wait.
      await db`update square_webhook_events set next_attempt_at=now() where event_id=${eventId}`;
      await drain();
      const [row] = await db<{
        status: string; attempts: number; processedAt: Date | null;
        businessId: string | null; lastError: string | null;
      }[]>`
        select status, attempts, processed_at, business_id, last_error
        from square_webhook_events where event_id=${eventId}
      `;
      return row!;
    }

    // This checkout id belongs to no Pawsh row. That might mean our own transaction has not
    // committed yet, so the first attempts retry rather than conclude anything.
    for (let attempt = 1; attempt < 3; attempt += 1) {
      const row = await claimAgain();
      expect(row.status, `attempt ${attempt}`).toBe("failed");
      expect(row.processedAt).toBeNull();
    }
    // By now it is not a race, it is somebody else's payment: a salon taking money directly on
    // its own Square account is not a Pawsh ledger event. Parked, never processed, never posted.
    const parked = await claimAgain();
    expect(parked.status).toBe("parked");
    expect(parked.processedAt).not.toBeNull();
    expect(parked.businessId).toBeNull();
    expect(parked.lastError).toContain("CHKSAMPLE00000001");

    // And nothing anywhere became money.
    const [payments] = await db<{ count: number }[]>`
      select count(*)::int as count from payments where provider='square'
        and provider_payment_id='PAYSAMPLE00000001' and business_id=${businessId}
    `;
    expect(payments!.count).toBe(0);
  });

  it("treats a redelivery as an acknowledgement, not an error", async () => {
    const body = await readFile("tests/fixtures/square/webhook-payment-updated.json");
    const eventId = JSON.parse(body.toString("utf8")).event_id as string;
    expect((await postWebhook(body)).json()).toMatchObject({ status: "recorded" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const repeat = await postWebhook(body);
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json()).toMatchObject({ status: "duplicate" });
    }
    const [count] = await db<{ count: number }[]>`
      select count(*)::int as count from square_webhook_events where event_id=${eventId}
    `;
    expect(count!.count).toBe(1);
  });

  it("refuses two rows for one Square event id", async () => {
    await expect(db`
      insert into square_webhook_events (event_id, merchant_id, event_type, payload)
      values ('44444444-4444-4444-8444-444444444444', ${merchantId}, 'payment.updated', '{}'::jsonb)
    `).rejects.toThrow();
  });

  it("pairs a device from the device code id, which is the only key the event carries", async () => {
    const body = await readFile("tests/fixtures/square/webhook-device-code-paired.json");
    expect((await postWebhook(body)).statusCode).toBe(200);
    await drain();

    const [device] = await db<{
      pairingStatus: string; squareDeviceId: string | null; pairedAt: Date | null; businessId: string;
    }[]>`
      select pairing_status, square_device_id, paired_at, business_id
      from square_devices where device_code_id='DCSAMPLE00000001'
    `;
    expect(device!.pairingStatus).toBe("paired");
    expect(device!.squareDeviceId).toBe("DEVICESAMPLE0001");
    expect(device!.pairedAt).not.toBeNull();
    expect(device!.businessId).toBe(businessId);

    const [event] = await db<{ businessId: string | null; status: string }[]>`
      select business_id, status from square_webhook_events
      where event_id='22222222-2222-4222-8222-222222222222'
    `;
    // The tenant is a conclusion of processing, not an input to receiving.
    expect(event!.businessId).toBe(businessId);
    expect(event!.status).toBe("processed");
  });

  // ---------------------------------------------------------------------------
  // Revocation
  // ---------------------------------------------------------------------------

  it("revokes on the merchant id alone, clears the tokens, and stops the connection working", async () => {
    const body = await readFile("tests/fixtures/square/webhook-oauth-authorization-revoked.json");
    expect((await postWebhook(body)).statusCode).toBe(200);
    await drain();

    const [connection] = await db<{
      status: string; accessToken: string | null; refreshToken: string | null; revokedAt: Date | null;
    }[]>`
      select status, access_token, refresh_token, revoked_at
      from square_connections where business_id=${businessId}
    `;
    expect(connection!.status).toBe("revoked");
    // A token we have been told is dead is not a credential, it is a liability in a backup.
    expect(connection!.accessToken).toBeNull();
    expect(connection!.refreshToken).toBeNull();
    expect(connection!.revokedAt).not.toBeNull();

    // Nothing can start work on a revoked connection.
    expect(await openAccessToken(db, { businessId, keyring }))
      .toEqual({ usable: false, reason: "revoked" });

    const read = await app.inject({
      method: "GET", url: "/api/integrations/square", headers: { cookie: ownerCookie }
    });
    expect(read.json().connection).toMatchObject({ status: "revoked" });
  });

  it("cannot represent a revoked connection that still holds credentials", async () => {
    await expect(db`
      update square_connections set access_token='v1.zzzz' where business_id=${businessId}
    `).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // The ledger
  // ---------------------------------------------------------------------------

  it("refuses a second posting of the same Square payment, and allows it in another business", async () => {
    async function invoiceFor(business: string, location: string): Promise<{ invoiceId: string; userId: string }> {
      const [user] = await db<{ id: string }[]>`
        select user_id as id from business_memberships
        where business_id=${business} and is_owner order by created_at limit 1
      `;
      const [customer] = await db<{ id: string }[]>`
        insert into customers(business_id,first_name,last_name)
        values (${business},'Pay','Twice') returning id
      `;
      const [pet] = await db<{ id: string }[]>`
        insert into pets(business_id,customer_id,name)
        values (${business},${customer!.id},'Mochi') returning id
      `;
      const [employee] = await db<{ id: string }[]>`
        insert into employees(business_id,display_name) values (${business},'Groomer') returning id
      `;
      const start = `2026-09-0${business === businessId ? "1" : "2"}T17:00:00Z`;
      const end = `2026-09-0${business === businessId ? "1" : "2"}T18:00:00Z`;
      const [appointment] = await db<{ id: string }[]>`
        insert into appointments
          (business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
           scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,created_by,updated_by)
        values (${business},${location},${customer!.id},${pet!.id},${employee!.id},
          ${start},${end},'America/Los_Angeles',
          ${start}::timestamptz at time zone 'America/Los_Angeles',-420,${user!.id},${user!.id})
        returning id
      `;
      const [invoice] = await db<{ id: string }[]>`
        insert into invoices(business_id,appointment_id,customer_id,status,subtotal_minor,total_minor,balance_minor)
        values (${business},${appointment!.id},${customer!.id},'open',6500,6500,6500)
        returning id
      `;
      return { invoiceId: invoice!.id, userId: user!.id };
    }

    const mine = await invoiceFor(businessId, locationId);
    const theirs = await invoiceFor(rivalBusinessId, rivalLocationId);

    const post = (business: string, invoiceId: string, userId: string, providerPaymentId: string) => db`
      insert into payments
        (business_id,invoice_id,amount_minor,method,recorded_by,provider,provider_payment_id,provider_tip_minor)
      values (${business},${invoiceId},6500,'external_card',${userId},'square',${providerPaymentId},1000)
    `;

    await post(businessId, mine.invoiceId, mine.userId, "PAYSAMPLE00000001");
    // The retry. Application code that checked first would lose this race; the index does not.
    await expect(post(businessId, mine.invoiceId, mine.userId, "PAYSAMPLE00000001")).rejects.toThrow();
    // The same Square payment id in another business is a different payment, and is allowed:
    // the index is scoped to the tenant exactly as every other constraint here is.
    await post(rivalBusinessId, theirs.invoiceId, theirs.userId, "PAYSAMPLE00000001");

    // Payments without a provider are unaffected: any number of them may coexist.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await db`
        insert into payments(business_id,invoice_id,amount_minor,method,recorded_by)
        values (${businessId},${mine.invoiceId},100,'cash',${mine.userId})
      `;
    }

    // Half-filled provider identity is refused, because it would sit outside the unique index.
    await expect(db`
      insert into payments
        (business_id,invoice_id,amount_minor,method,recorded_by,provider)
      values (${businessId},${mine.invoiceId},6500,'external_card',${mine.userId},'square')
    `).rejects.toThrow();
    await expect(db`
      insert into payments
        (business_id,invoice_id,amount_minor,method,recorded_by,provider_payment_id)
      values (${businessId},${mine.invoiceId},6500,'external_card',${mine.userId},'PAYSAMPLE00000002')
    `).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // The scheduled refresh
  //
  // Square's access token lasts 30 days and its instruction is to refresh every seven days or
  // fewer regardless of activity. A salon that takes no card payments for a month produces no
  // request to fail, so a refresh-on-401 scheme would never fire and the token would die quietly.
  // ---------------------------------------------------------------------------

  it("refreshes a connection that is due, and reseals it under the active key", async () => {
    const business = await freshBusiness("refresh");
    await storeConnection(db, {
      businessId: business, environment: "sandbox", merchantId: `MREFRESH${suffix.slice(0, 8)}`,
      accessToken: "old-access-token", refreshToken: "old-refresh-token",
      accessTokenExpiresAt: new Date("2026-09-01T00:00:00Z"),
      scopes: ["PAYMENTS_READ"], keyring
    });
    await db`update square_connections set next_refresh_at=now()-interval '1 minute' where business_id=${business}`;

    expect(await refreshDueConnections(db, {
      client: square.client, keyring, environment: "sandbox"
    })).toBeGreaterThanOrEqual(1);

    const [row] = await db<{
      accessToken: string; refreshToken: string; refreshedAt: Date; nextRefreshAt: Date;
      refreshAttempts: number; lastRefreshError: string | null; daysAhead: number;
    }[]>`
      select access_token, refresh_token, refreshed_at, next_refresh_at, refresh_attempts,
        last_refresh_error,
        -- next_refresh_at is written as now() + make_interval(...) by the database, so the
        -- distance to it has to be measured on the database clock as well. Subtracting a
        -- client-side Date.now() compares two clocks, and any skew between the application
        -- host and the PostgreSQL host lands straight on the upper bound asserted below.
        (extract(epoch from (next_refresh_at - now())) / 86400)::float8 as days_ahead
      from square_connections where business_id=${business}
    `;
    // The token Square just issued, not the one the row held a moment ago. The stub advances its
    // access token on every refresh precisely so a row that quietly kept the old one would fail
    // here rather than pass by coincidence.
    expect(keyring.open(row!.accessToken, {
      businessId: business, table: "square_connections", column: "access_token"
    })).toBe(square.state.accessToken);
    expect(square.state.accessToken).not.toBe(accessToken);
    // The code flow's refresh token does not rotate, so it is resealed rather than replaced -
    // which is also how a rotated keyring drains without a migration.
    expect(keyring.open(row!.refreshToken, {
      businessId: business, table: "square_connections", column: "refresh_token"
    })).toBe(refreshToken);
    expect(row!.refreshAttempts).toBe(0);
    expect(row!.lastRefreshError).toBeNull();
    expect(row!.daysAhead).toBeGreaterThan(6.5);
    expect(row!.daysAhead).toBeLessThanOrEqual(7);

    // Nothing is due any more, so the next tick claims nothing rather than hammering Square.
    expect(await refreshDueConnections(db, {
      client: square.client, keyring, environment: "sandbox"
    })).toBe(0);
  });

  it("stops refreshing a connection Square says is revoked, and backs off on anything else", async () => {
    const revokedBusiness = await freshBusiness("revoked-refresh");
    await storeConnection(db, {
      businessId: revokedBusiness, environment: "sandbox",
      merchantId: `MREVOKED${suffix.slice(0, 8)}`,
      accessToken: "access", refreshToken: "refresh", accessTokenExpiresAt: null,
      scopes: [], keyring
    });
    await db`update square_connections set next_refresh_at=now()-interval '1 minute' where business_id=${revokedBusiness}`;
    await refreshDueConnections(db, {
      client: {
        ...square.client,
        refreshAccessToken: async () => {
          throw new SquareApiError("access_token_revoked", "revoked", 401);
        }
      },
      keyring, environment: "sandbox"
    });
    const [revoked] = await db<{ status: string; refreshToken: string | null }[]>`
      select status, refresh_token from square_connections where business_id=${revokedBusiness}
    `;
    expect(revoked!.status).toBe("revoked");
    expect(revoked!.refreshToken).toBeNull();

    const flakyBusiness = await freshBusiness("flaky-refresh");
    await storeConnection(db, {
      businessId: flakyBusiness, environment: "sandbox", merchantId: `MFLAKY${suffix.slice(0, 8)}`,
      accessToken: "access", refreshToken: "refresh", accessTokenExpiresAt: null,
      scopes: [], keyring
    });
    await db`update square_connections set next_refresh_at=now()-interval '1 minute' where business_id=${flakyBusiness}`;
    await refreshDueConnections(db, {
      client: {
        ...square.client,
        refreshAccessToken: async () => {
          throw new SquareApiError("square_unavailable", "Square is down", 503);
        }
      },
      keyring, environment: "sandbox"
    });
    const [flaky] = await db<{
      status: string; refreshAttempts: number; lastRefreshError: string | null; nextRefreshAt: Date;
    }[]>`
      select status, refresh_attempts, last_refresh_error, next_refresh_at
      from square_connections where business_id=${flakyBusiness}
    `;
    // Still connected, the failure recorded, and the next attempt pushed out rather than retried
    // on every fifteen-second worker tick.
    expect(flaky!.status).toBe("connected");
    expect(flaky!.refreshAttempts).toBe(1);
    expect(flaky!.lastRefreshError).toContain("Square is down");
    expect(flaky!.nextRefreshAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("refuses a terminal checkout that points at another business's invoice or device", async () => {
    const [device] = await db<{ id: string }[]>`
      select id from square_devices where business_id=${businessId} limit 1
    `;
    const [invoice] = await db<{ id: string }[]>`
      select id from invoices where business_id=${rivalBusinessId} limit 1
    `;
    const [owner] = await db<{ id: string }[]>`
      select user_id as id from business_memberships
      where business_id=${businessId} and is_owner limit 1
    `;
    await expect(db`
      insert into square_terminal_checkouts
        (business_id, invoice_id, device_id, idempotency_key, amount_minor, currency, created_by)
      values (${businessId}, ${invoice!.id}, ${device!.id}, ${crypto.randomUUID()}, 6500, 'USD', ${owner!.id})
    `).rejects.toThrow();
  });
});
