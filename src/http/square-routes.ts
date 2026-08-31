import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { setTenant, type Database } from "../db/client.js";
import { auth, authentication, requirePermission } from "./context.js";
import {
  claimFinancialRequest, completeFinancialRequest, FinancialRequestError, idempotencyKey, record
} from "./routes.js";
import { canonicalHash } from "../domain/canonical.js";
import { paymentRefundSchema } from "./schemas.js";
import {
  claimPaymentRefund, listPaymentRefunds, readPaymentRefund, reconcileRefund, refundPresentation,
  type PaymentRefundRow
} from "../integrations/square/refunds.js";
import {
  createSquareClient, squareScopes, type SquareClient
} from "../integrations/square/client.js";
import { SquareApiError } from "../integrations/square/errors.js";
import {
  consumeOAuthState, createOAuthState, markDisconnected, openAccessToken, readConnection,
  storeConnection, withSquareAccess, oauthStateTtlMs, type SquareWorkerDependencies
} from "../integrations/square/oauth.js";
import { reconcileCheckout } from "../integrations/square/reconciliation.js";
import {
  applyDeviceCodeState, bindSquareCheckout, checkoutPresentation, claimTerminalCheckout,
  devicePairingView, listInvoiceCheckouts, listSquareDevices, mapSquareCheckoutStatus,
  markCheckoutFailed, noteCheckoutError, readSquareDevice, readTerminalCheckout,
  recordIssuedDeviceCode, type SquareDeviceRow, type TerminalCheckoutRow
} from "../integrations/square/terminal.js";
import {
  squareIntegration, squareUnavailableCode, type SquareIntegrationSettings
} from "../integrations/square/settings.js";
import {
  parseWebhookEnvelope, recordWebhookEvent, squareSignatureHeader, verifySquareSignature
} from "../integrations/square/webhooks.js";

/**
 * The Square endpoints: three a salon owner uses, and one Square uses.
 *
 * Registered from `app.ts` rather than folded into `routes.ts` because the webhook receiver
 * needs a content-type parser that no other route in this application wants. Fastify scopes a
 * parser to the plugin that registers it, so the raw-body parser lives inside an encapsulated
 * register call here and every other route keeps the ordinary JSON parsing it has always had.
 *
 * NOTHING HERE EVER RETURNS A TOKEN. Not the access token, not the refresh token, not sealed,
 * not truncated, not behind a permission. The client secret never leaves configuration. The
 * status read exists so a screen can show what is connected without any route needing to hand
 * out the credential that makes it work.
 *
 * WHEN SQUARE IS NOT CONFIGURED THESE ROUTES SAY SO. No Square credentials exist for this
 * project yet, so unconfigured is the normal local state, and it answers 503 with the variable
 * that is missing rather than pretending to be disconnected - which would read as "a salon that
 * has not connected yet" and send somebody looking for a button that cannot work.
 */

/**
 * Pairing and capture, in bodies that cannot name somebody else's hardware.
 *
 * Every one of these takes Pawsh uuids. The single exception is `squareLocationId` on device
 * creation, and it is an exception with a fence around it: that value is the choice the operator
 * is making, it is offered from a live `listLocations` read rather than a table of ours, and the
 * route re-fetches that list and refuses anything not in it before a row is written. Every later
 * mutation - issue a code, re-read it, start a checkout, cancel one - resolves the Square location
 * id, the device id and the checkout id out of the row, server side, because a route that took
 * them from a body would let one salon's browser name another salon's terminal.
 *
 * There is no amount field anywhere here. A Terminal checkout is charged for the invoice balance
 * the server reads under a lock, and a client that wanted to charge something else would have to
 * change the invoice first - which is a different, audited act.
 */
const idParams = z.object({ id: z.string().uuid() });

const deviceCreateSchema = z.object({
  locationId: z.string().uuid(),
  squareLocationId: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(60)
});

const terminalCheckoutStartSchema = z.object({
  deviceId: z.string().uuid()
});

/** The same sentence wherever a connection is missing, revoked or stood down by the salon. */
function notConnected(reason: "absent" | "revoked" | "disconnected") {
  return {
    code: "SQUARE_NOT_CONNECTED",
    error: reason === "revoked"
      ? "The Square connection was revoked. Reconnect Square before taking payments on a terminal."
      : "Connect Square before taking payments on a terminal."
  };
}

/**
 * Why a Terminal checkout could not be started, in sentences a groomer can act on.
 *
 * Each one names a different thing to do next, which is why they are separate codes rather than
 * one refusal: an invoice that is already paid needs no action, an invoice carrying a tip has to be
 * taken another way, and an unpaired terminal is a settings problem somebody else has to fix.
 */
const startRefusals = {
  invoice_not_found: { status: 404, code: "INVOICE_NOT_FOUND", error: "Invoice not found" },
  invoice_not_payable: {
    status: 409, code: "INVOICE_NOT_PAYABLE",
    error: "This invoice has nothing left to pay."
  },
  invoice_has_tip: {
    status: 409, code: "INVOICE_HAS_TIP",
    error: "This invoice already has a tip on it, so it cannot be taken on the terminal. "
      + "The terminal asks the customer for the tip itself."
  },
  device_not_paired: {
    status: 409, code: "SQUARE_DEVICE_NOT_PAIRED",
    error: "That terminal is not paired."
  },
  currency_unknown: {
    status: 409, code: "BUSINESS_CURRENCY_UNKNOWN",
    error: "This salon has no valid currency set, so a card payment cannot be taken."
  }
} as const;

function startFailureMessage(error: unknown): string {
  if (!(error instanceof SquareApiError)) return "The terminal could not be reached.";
  switch (error.code) {
    case "timeout":
    case "network_failure":
    case "square_unavailable":
      return "The terminal could not be reached. Nothing was charged; try again.";
    case "rate_limited":
      return "Square is busy. Nothing was charged; try again in a moment.";
    case "not_found":
      return "Square does not recognise this terminal. Re-pair it in Settings.";
    case "insufficient_scopes":
      return "Square has not granted Pawsh permission to take payments. Reconnect Square.";
    case "idempotency_key_reused":
      // Ours, never Square's, and it must surface rather than be retried into silence.
      return "Pawsh sent a conflicting request for this payment. Nothing was charged; "
        + "tell your administrator before trying again.";
    default:
      return "Square refused to start the payment. Nothing was charged.";
  }
}

const connectCallbackSchema = z.object({
  code: z.string().min(1).max(1024).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(128).optional(),
  error_description: z.string().max(1024).optional()
}).loose();

export interface SquareRouteOptions {
  /** Injected by tests. Built from configuration when absent. */
  client?: SquareClient | undefined;
}

export function registerSquareRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
  options: SquareRouteOptions = {}
): void {
  const authenticate = authentication(db);
  const availability = squareIntegration(config);

  function client(settings: SquareIntegrationSettings): SquareClient {
    return options.client ?? createSquareClient({
      environment: settings.environment,
      applicationId: settings.applicationId,
      applicationSecret: settings.applicationSecret
    });
  }

  function settingsRedirect(outcome: string, detail?: string): string {
    const url = new URL("/settings/integrations", config.APP_ORIGIN);
    url.searchParams.set("square", outcome);
    if (detail) url.searchParams.set("reason", detail);
    return url.toString();
  }

  function dependencies(settings: SquareIntegrationSettings): SquareWorkerDependencies {
    return {
      client: client(settings), keyring: settings.keyring, environment: settings.environment
    };
  }

  /**
   * A device as a screen may see it.
   *
   * The pairing code is returned only while it can still be typed in. Once `pair_by` has passed,
   * `devicePairingView` reports `expired` and withholds the code, because showing a dead code
   * beside a "waiting to pair" label is how a salon ends up typing it into a terminal repeatedly.
   */
  function presentDevice(row: SquareDeviceRow, now: Date) {
    const view = devicePairingView(row, now);
    return {
      id: row.id,
      locationId: row.locationId,
      label: row.label,
      pairingStatus: view.status,
      pairingCode: view.code,
      pairBy: view.pairBy,
      pairedAt: row.pairedAt,
      // Never `square_device_id` and never `square_location_id`. A screen has no use for either,
      // and a value a client holds is a value a client can send back.
      createdAt: row.createdAt
    };
  }

  /**
   * A checkout as a screen may see it.
   *
   * `settled` is the only thing the client is allowed to render as success, and only the
   * reconciler ever sets the status that produces it. The tip is reported from the posted payment
   * rather than from the checkout, so there is no figure to show before the money is real.
   */
  async function presentCheckout(row: TerminalCheckoutRow) {
    const presentation = checkoutPresentation(row);
    const [payment] = row.paymentId
      ? await db<{ amountMinor: number; providerTipMinor: number | null }[]>`
        select amount_minor, provider_tip_minor from payments
        where business_id=${row.businessId} and id=${row.paymentId}
      `
      : [];
    return {
      id: row.id,
      invoiceId: row.invoiceId,
      deviceId: row.deviceId,
      status: row.status,
      amountMinor: row.amountMinor,
      currency: row.currency,
      attempt: row.attempt,
      cancelReason: row.cancelReason,
      lastError: row.lastError,
      mismatch: row.mismatch,
      paymentId: row.paymentId,
      reconciledAt: row.reconciledAt,
      paidTotalMinor: payment?.amountMinor ?? null,
      tipMinor: payment?.providerTipMinor ?? null,
      ...presentation
    };
  }

  /**
   * The tip presets that go to the device.
   *
   * The salon's own three numbers, from the `card_processors` row for Square, so the terminal
   * offers exactly what the checkout screen already shows and there is no second place to
   * configure a tip. Connecting Square records that row, so the fallback below is only reachable
   * for a connection made before it did; it uses the same defaults the column itself carries
   * rather than inventing a fourth set of numbers.
   */
  async function squareTipPercents(businessId: string): Promise<number[]> {
    const [processor] = await db<{ p1: number; p2: number; p3: number }[]>`
      select tip_percent_1 as p1, tip_percent_2 as p2, tip_percent_3 as p3
      from card_processors where business_id=${businessId}
      order by (provider='square') desc, is_default desc, id limit 1
    `;
    return processor ? [processor.p1, processor.p2, processor.p3] : [15, 18, 20];
  }

  // ---------------------------------------------------------------------------
  // Status. Safe to call whether or not Square is configured, because the answer to "can this
  // deployment connect Square" is exactly what the caller needs when it cannot.
  // ---------------------------------------------------------------------------

  app.get("/api/integrations/square", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request) => {
    const context = auth(request);
    const connection = availability.available ? await readConnection(db, context.businessId) : null;
    return {
      configured: availability.available,
      reason: availability.available ? null : availability.reason,
      environment: availability.available ? availability.settings.environment : null,
      requestedScopes: [...squareScopes],
      devices: connection && connection.status === "connected"
        ? (await listSquareDevices(db, context.businessId))
          .map((device) => presentDevice(device, new Date()))
        : [],
      connection: connection && {
        status: connection.status,
        merchantId: connection.squareMerchantId,
        environment: connection.environment,
        scopes: connection.scopes,
        connectedAt: connection.connectedAt,
        refreshedAt: connection.refreshedAt,
        revokedAt: connection.revokedAt,
        accessTokenExpiresAt: connection.accessTokenExpiresAt
      }
    };
  });

  // ---------------------------------------------------------------------------
  // Start the OAuth flow. The state is minted and stored before the URL is handed back, so a
  // callback can never arrive for a state this server has no record of issuing.
  // ---------------------------------------------------------------------------

  app.post("/api/integrations/square/connect", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const state = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const issued = await createOAuthState(tx, {
        businessId: context.businessId,
        userId: context.userId,
        environment: settings.environment,
        redirectUri: settings.redirectUri
      });
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "integration.square.connect.start", resourceType: "square_connection",
        after: { environment: settings.environment, scopes: [...squareScopes] }
      });
      return issued;
    });
    return {
      authorizeUrl: client(settings).authorizeUrl({ state, redirectUri: settings.redirectUri }),
      expiresInSeconds: Math.round(oauthStateTtlMs / 1000)
    };
  });

  // ---------------------------------------------------------------------------
  // Where Square sends the merchant's browser back.
  //
  // Authenticated: the session cookie is `SameSite=Lax`, so it rides a top-level navigation, and
  // requiring it means the connection is attached to the business whose owner actually started
  // the flow rather than to whoever the state says. Both checks are applied - the session names
  // the business, the state must agree - because either alone is weaker than both.
  // ---------------------------------------------------------------------------

  app.get("/api/integrations/square/callback", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const query = connectCallbackSchema.parse(request.query);

    // The merchant declined, or Square refused. Nothing was issued, so there is nothing to undo;
    // the state is left to expire on its own rather than being consumed by a failed attempt.
    if (query.error || !query.code || !query.state) {
      return reply.redirect(settingsRedirect("error", query.error ?? "missing_code"), 303);
    }

    const state = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      return consumeOAuthState(tx, { state: query.state!, businessId: context.businessId });
    });
    if (!state.valid) {
      return reply.redirect(settingsRedirect("error", `state_${state.reason}`), 303);
    }

    let grant;
    try {
      grant = await client(settings).exchangeAuthorizationCode({
        code: query.code, redirectUri: state.redirectUri
      });
    } catch (error) {
      request.log.error({ err: error }, "square authorization code exchange failed");
      const code = error instanceof SquareApiError ? error.code : "exchange_failed";
      return reply.redirect(settingsRedirect("error", code), 303);
    }
    if (!grant.refreshToken) {
      // The authorization-code grant always returns one. Without it we could never refresh, and
      // a connection that cannot be refreshed is a connection that dies silently in 30 days.
      return reply.redirect(settingsRedirect("error", "missing_refresh_token"), 303);
    }

    // What the merchant actually granted, rather than what we asked for. Non-fatal: an empty
    // list records "not yet known" and the next refresh fills it in, which is more honest than
    // writing the requested scopes and calling them granted.
    let scopes: string[] = [];
    try {
      scopes = (await client(settings).retrieveTokenStatus({ accessToken: grant.accessToken })).scopes;
    } catch (error) {
      request.log.warn({ err: error }, "square token status unavailable");
    }

    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      await storeConnection(tx, {
        businessId: context.businessId,
        environment: settings.environment,
        merchantId: grant.merchantId,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken!,
        accessTokenExpiresAt: grant.expiresAt,
        scopes,
        keyring: settings.keyring
      });
      // Connecting Square is the salon saying it takes card payments through Square, which is
      // exactly what a `card_processors` row records. Writing it here is what keeps the tip
      // presets in one place: the same three numbers the checkout screen already shows are the
      // ones pushed to the terminal. `on conflict do nothing` because a salon that recorded the
      // processor by hand has already said this, and its own tip settings must not be replaced.
      const [existingProcessors] = await tx<{ count: number }[]>`
        select count(*)::int as count from card_processors where business_id=${context.businessId}
      `;
      await tx`
        insert into card_processors (business_id, provider, is_default)
        values (${context.businessId}, 'square', ${(existingProcessors?.count ?? 0) === 0})
        on conflict (business_id, provider) do nothing
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "integration.square.connected", resourceType: "square_connection",
        after: { merchantId: grant.merchantId, environment: settings.environment, scopes }
      });
    });
    return reply.redirect(settingsRedirect("connected"), 303);
  });

  // ---------------------------------------------------------------------------
  // Stop.
  //
  // Revoked at Square first, cleared here second. The other order would leave a live token in
  // somebody else's system that we no longer hold and therefore could never revoke.
  // ---------------------------------------------------------------------------

  app.post("/api/integrations/square/disconnect", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const access = await openAccessToken(db, {
      businessId: context.businessId, keyring: settings.keyring
    });
    if (!access.usable && access.reason === "absent") {
      return reply.code(404).send({ error: "This business has no Square connection" });
    }
    if (access.usable) {
      try {
        await client(settings).revokeAccessToken({ accessToken: access.accessToken });
      } catch (error) {
        // A credential Square has already invalidated is not a reason to refuse: it is the
        // outcome we were asking for. Anything else is transient, and the local row is kept so
        // the revocation can be retried rather than orphaned.
        if (!(error instanceof SquareApiError) || !error.credentialFailure) {
          request.log.error({ err: error }, "square token revocation failed");
          return reply.code(502).send({
            code: "SQUARE_REVOCATION_FAILED",
            error: "Square could not be reached to revoke the connection. Nothing was changed; try again."
          });
        }
      }
    }
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      await markDisconnected(tx, context.businessId);
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "integration.square.disconnected", resourceType: "square_connection"
      });
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------
  // Pairing.
  //
  // A terminal becomes usable in three steps, and each one is a separate act with its own audit
  // entry: name the machine and the Square location it takes money for, ask Square for a code, and
  // let the salon type that code into the hardware. Square tells us the third step happened through
  // `device.code.paired`; the refresh route below exists because a webhook can be missed and a
  // salon looking at a terminal that says it is paired must have a way to make Pawsh agree.
  // ---------------------------------------------------------------------------

  /**
   * The merchant's Square locations, read live every time.
   *
   * Deliberately not cached and deliberately not mirrored into a table. A stale copy of somebody
   * else's locations is worse than no copy: it offers a location that has been closed, or hides one
   * that was opened this morning, and the salon has no way to tell which.
   */
  app.get("/api/integrations/square/locations", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const [business] = await db<{ currency: string }[]>`
      select currency from businesses where id=${context.businessId}
    `;
    const currency = (business?.currency ?? "USD").toUpperCase();
    const outcome = await withSquareAccess(db, dependencies(settings), context.businessId,
      async (token) => client(settings).listLocations({ accessToken: token }));
    if (!outcome.ok) return reply.code(409).send(notConnected(outcome.reason));
    return {
      currency,
      locations: outcome.value.map((location) => ({
        id: location.id,
        name: location.name,
        status: location.status,
        currency: location.currency,
        // A location that settles in another currency is offered as unusable rather than hidden.
        // Hiding it would leave an owner hunting for a location they can see in Square's own
        // dashboard, with nothing on the screen to say why Pawsh will not take it.
        usable: (location.currency ?? currency).toUpperCase() === currency
          && (location.status ?? "ACTIVE").toUpperCase() === "ACTIVE"
      }))
    };
  });

  /**
   * Names a terminal.
   *
   * The Square location id is checked against a live `listLocations` read before anything is
   * written. That is what turns "a string in a request body" into "a location this merchant
   * actually owns", and it is the only Square identifier any route here accepts.
   */
  app.post("/api/integrations/square/devices", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const input = deviceCreateSchema.parse(request.body);
    const [business] = await db<{ currency: string }[]>`
      select currency from businesses where id=${context.businessId}
    `;
    const currency = (business?.currency ?? "USD").toUpperCase();
    const outcome = await withSquareAccess(db, dependencies(settings), context.businessId,
      async (token) => client(settings).listLocations({ accessToken: token }));
    if (!outcome.ok) return reply.code(409).send(notConnected(outcome.reason));
    const chosen = outcome.value.find((location) => location.id === input.squareLocationId);
    if (!chosen) {
      return reply.code(400).send({
        code: "SQUARE_LOCATION_UNKNOWN",
        error: "That Square location does not belong to the connected account."
      });
    }
    if ((chosen.currency ?? currency).toUpperCase() !== currency) {
      // Refused here rather than at reconciliation, because by reconciliation the money has moved
      // and all that is left is to refuse to post it.
      return reply.code(409).send({
        code: "SQUARE_LOCATION_CURRENCY",
        error: `That Square location settles in ${chosen.currency}, and this salon invoices in ${currency}.`
      });
    }
    const created = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [location] = await tx<{ id: string }[]>`
        select id from locations where business_id=${context.businessId} and id=${input.locationId}
      `;
      if (!location) return null;
      const [device] = await tx<{ id: string }[]>`
        insert into square_devices (business_id, location_id, square_location_id, label)
        values (${context.businessId}, ${input.locationId}, ${input.squareLocationId}, ${input.label})
        returning id
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "integration.square.device.create", resourceType: "square_device",
        resourceId: device!.id,
        after: {
          label: input.label, locationId: input.locationId,
          squareLocationId: input.squareLocationId
        }
      });
      return device!.id;
    });
    if (!created) return reply.code(404).send({ error: "Location not found" });
    const row = await readSquareDevice(db, { businessId: context.businessId, deviceId: created });
    return reply.code(201).send(presentDevice(row!, new Date()));
  });

  /**
   * Asks Square for a pairing code, or a fresh one.
   *
   * Re-issuing clears any existing pairing. That is what issuing a code means - the machine that
   * types the new code in is the machine this row now describes - and keeping the old device id
   * would be a claim about hardware nobody can see.
   *
   * The idempotency key here is a fresh uuid, which is deliberate rather than an oversight. A
   * device code is not money: a duplicated request costs an unused code that expires on its own,
   * while a key derived from the row would make the second request return the previous, expired
   * code - the exact outcome this route exists to escape. The derived key belongs on the checkout,
   * where a repeat is a second charge.
   */
  app.post("/api/integrations/square/devices/:id/code", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const { id } = idParams.parse(request.params);
    const device = await readSquareDevice(db, { businessId: context.businessId, deviceId: id });
    if (!device) return reply.code(404).send({ error: "Terminal not found" });

    const outcome = await withSquareAccess(db, dependencies(settings), context.businessId,
      async (token) => client(settings).createDeviceCode({
        accessToken: token,
        idempotencyKey: randomUUID(),
        // Resolved from the row, never from the request body.
        squareLocationId: device.squareLocationId,
        name: device.label
      }));
    if (!outcome.ok) return reply.code(409).send(notConnected(outcome.reason));
    const updated = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const row = await recordIssuedDeviceCode(tx, {
        businessId: context.businessId, deviceId: id, deviceCode: outcome.value
      });
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "integration.square.device.code.issue", resourceType: "square_device",
        resourceId: id,
        after: { deviceCodeId: outcome.value.id, pairBy: outcome.value.pair_by ?? null }
      });
      return row;
    });
    if (!updated) return reply.code(404).send({ error: "Terminal not found" });
    return presentDevice(updated, new Date());
  });

  /**
   * Re-reads a device code from Square.
   *
   * `device.code.paired` is the production path; this is what a salon presses when the terminal
   * says it is paired and Pawsh has not heard. Both paths converge through `applyDeviceCodeState`,
   * so they cannot reach different conclusions about the same code.
   */
  app.post("/api/integrations/square/devices/:id/refresh", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const { id } = idParams.parse(request.params);
    const device = await readSquareDevice(db, { businessId: context.businessId, deviceId: id });
    if (!device) return reply.code(404).send({ error: "Terminal not found" });
    if (!device.deviceCodeId) {
      return reply.code(409).send({
        code: "SQUARE_DEVICE_NO_CODE",
        error: "This terminal has no pairing code yet. Get a code first."
      });
    }
    const outcome = await withSquareAccess(db, dependencies(settings), context.businessId,
      async (token) => client(settings).retrieveDeviceCode({
        accessToken: token, deviceCodeId: device.deviceCodeId!
      }));
    if (!outcome.ok) return reply.code(409).send(notConnected(outcome.reason));
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      await applyDeviceCodeState(tx, { deviceCode: outcome.value });
    });
    const row = await readSquareDevice(db, { businessId: context.businessId, deviceId: id });
    return presentDevice(row!, new Date());
  });

  /**
   * Forgets a terminal.
   *
   * Refused while a checkout still points at it. A `square_terminal_checkouts` row is the record of
   * an attempt to take money, and deleting the device it names would leave that record unable to
   * say which machine it happened on.
   */
  app.delete("/api/integrations/square/devices/:id", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const outcome = await db.begin<"deleted" | "referenced" | "missing">(async (tx) => {
      await setTenant(tx, context.businessId);
      const [used] = await tx<{ id: string }[]>`
        select id from square_terminal_checkouts
        where business_id=${context.businessId} and device_id=${id} limit 1
      `;
      if (used) return "referenced";
      const [deleted] = await tx<{ id: string; label: string }[]>`
        delete from square_devices where business_id=${context.businessId} and id=${id}
        returning id, label
      `;
      if (!deleted) return "missing";
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "integration.square.device.delete", resourceType: "square_device",
        resourceId: id, before: { label: deleted.label }
      });
      return "deleted";
    });
    if (outcome === "missing") return reply.code(404).send({ error: "Terminal not found" });
    if (outcome === "referenced") {
      return reply.code(409).send({
        code: "SQUARE_DEVICE_IN_USE",
        error: "This terminal has taken payments, so its record is kept."
      });
    }
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------
  // Capture.
  //
  // Gated on `checkout.perform` rather than `settings.manage`, because the audience is the groomer
  // taking the money. The read below is narrow for the same reason `checkoutPaymentOptions` is:
  // somebody who takes payments must not be able to read the salon's Square configuration through
  // a side door, and the checkout screen needs none of it - only the terminals it may use.
  // ---------------------------------------------------------------------------

  app.get("/api/checkout/terminal", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request) => {
    const context = auth(request);
    if (!availability.available) return { available: false, devices: [] };
    const connection = await readConnection(db, context.businessId);
    if (!connection || connection.status !== "connected") return { available: false, devices: [] };
    const devices = await listSquareDevices(db, context.businessId);
    const paired = devices.filter((device) => device.pairingStatus === "paired");
    return {
      available: paired.length > 0,
      // Label and id only. No Square device id and no location id: a value a client holds is a
      // value a client can send back.
      devices: paired.map((device) => ({ id: device.id, label: device.label }))
    };
  });

  /**
   * Starts a checkout on a terminal.
   *
   * The order is the whole correctness argument. The local row is claimed first, inside a
   * transaction that locks the invoice, derives the amount from its balance and derives the
   * idempotency key from facts that are now on disk. Square is called second. If the response is
   * lost, the row survives with its key, a retry finds that same row, and Square answers the
   * repeated key with the checkout it already created rather than a second prompt to tap a card.
   *
   * The reverse order leaves a window in which Square holds a checkout we cannot name, and no way
   * to name it afterwards.
   */
  app.post("/api/invoices/:id/terminal-checkouts", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const { id } = idParams.parse(request.params);
    const input = terminalCheckoutStartSchema.parse(request.body);

    const claim = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const outcome = await claimTerminalCheckout(tx, {
        businessId: context.businessId, invoiceId: id,
        deviceId: input.deviceId, userId: context.userId
      });
      if (outcome.claimed && !outcome.reused) {
        await record(tx, {
          businessId: context.businessId, actorId: context.userId,
          action: "integration.square.checkout.start", resourceType: "square_terminal_checkout",
          resourceId: outcome.checkout.id,
          after: {
            invoiceId: id, deviceId: input.deviceId, attempt: outcome.checkout.attempt,
            amountMinor: outcome.checkout.amountMinor, currency: outcome.checkout.currency
          }
        });
      }
      return outcome;
    });
    if (!claim.claimed) {
      const refusal = startRefusals[claim.reason];
      return reply.code(refusal.status).send({ code: refusal.code, error: refusal.error });
    }

    const checkout = claim.checkout;
    // Already bound to a Square checkout: this is a retry of a request that got through. There is
    // nothing to send, and sending it would be the thing this design exists to avoid.
    if (checkout.squareCheckoutId) {
      return reply.code(200).send(await presentCheckout(checkout));
    }

    const tipPercentages = await squareTipPercents(context.businessId);
    let outcome;
    try {
      outcome = await withSquareAccess(db, dependencies(settings), context.businessId,
        async (token) => client(settings).createTerminalCheckout({
          accessToken: token,
          // The stored key, byte for byte. Never re-derived here and never regenerated: the retry
          // path depends on this request being identical to the one that may already have landed.
          idempotencyKey: checkout.idempotencyKey,
          deviceId: claim.squareDeviceId,
          amountMinor: checkout.amountMinor,
          currency: checkout.currency,
          // Reconciliation metadata, capped by Square at 40 characters; a uuid is 36.
          referenceId: checkout.invoiceId,
          tipPercentages
        }));
    } catch (error) {
      const retryable = error instanceof SquareApiError && error.retryable;
      const reason = startFailureMessage(error);
      await db.begin(async (tx) => {
        await setTenant(tx, context.businessId);
        // A retryable failure leaves the attempt live, so pressing the button again reuses the
        // same key rather than asking Square for a second checkout.
        if (retryable) {
          await noteCheckoutError(tx, {
            businessId: context.businessId, checkoutId: checkout.id, reason
          });
        } else {
          await markCheckoutFailed(tx, {
            businessId: context.businessId, checkoutId: checkout.id, reason
          });
        }
      });
      const row = await readTerminalCheckout(db, {
        businessId: context.businessId, checkoutId: checkout.id
      });
      return reply.code(retryable ? 503 : 502).send({
        code: retryable ? "SQUARE_TERMINAL_UNAVAILABLE" : "SQUARE_TERMINAL_REFUSED",
        error: reason,
        checkout: await presentCheckout(row!)
      });
    }
    if (!outcome.ok) {
      const reason = "The Square connection was revoked, so this payment cannot be taken here.";
      await db.begin(async (tx) => {
        await setTenant(tx, context.businessId);
        await markCheckoutFailed(tx, {
          businessId: context.businessId, checkoutId: checkout.id, reason
        });
      });
      const row = await readTerminalCheckout(db, {
        businessId: context.businessId, checkoutId: checkout.id
      });
      return reply.code(409).send({
        code: "SQUARE_NOT_CONNECTED", error: reason, checkout: await presentCheckout(row!)
      });
    }

    const mapped = mapSquareCheckoutStatus(outcome.value.status);
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      await bindSquareCheckout(tx, {
        businessId: context.businessId, checkoutId: checkout.id,
        squareCheckoutId: outcome.value.id, status: mapped.status,
        cancelReason: outcome.value.cancel_reason ?? null
      });
    });
    const row = await readTerminalCheckout(db, {
      businessId: context.businessId, checkoutId: checkout.id
    });
    return reply.code(claim.reused ? 200 : 201).send(await presentCheckout(row!));
  });

  /**
   * The local state of a checkout. No Square call, so a screen may ask often.
   *
   * This is what the capture modal watches while a customer is at the terminal. Webhooks move the
   * row and this reports it; Square itself is reached only by the refresh route below, which a
   * person presses. Polling Square from an open modal would turn one payment into a request every
   * few seconds against an API that rate limits, and would make the recovery path the mechanism.
   */
  app.get("/api/square/terminal-checkouts/:id", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const row = await readTerminalCheckout(db, { businessId: context.businessId, checkoutId: id });
    if (!row) return reply.code(404).send({ error: "Terminal payment not found" });
    return presentCheckout(row);
  });

  app.get("/api/invoices/:id/terminal-checkouts", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const rows = await listInvoiceCheckouts(db, { businessId: context.businessId, invoiceId: id });
    return { checkouts: await Promise.all(rows.map(presentCheckout)) };
  });

  /**
   * Recovery: re-read this checkout from Square and reconcile it now.
   *
   * The same code the drain runs, so a salon pressing this cannot reach an outcome the worker
   * could not have reached on its own. It exists for the webhook that never arrived - and for the
   * fact that Square keeps Terminal checkouts for thirty days, after which this answers honestly
   * that the intent is no longer knowable, while the payment, if there was one, is in the ledger
   * where it has been all along.
   */
  app.post("/api/square/terminal-checkouts/:id/refresh", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const { id } = idParams.parse(request.params);
    const existing = await readTerminalCheckout(db, {
      businessId: context.businessId, checkoutId: id
    });
    if (!existing) return reply.code(404).send({ error: "Terminal payment not found" });
    try {
      await reconcileCheckout(db, dependencies(settings), {
        businessId: context.businessId, checkoutId: id
      });
    } catch (error) {
      request.log.warn({ err: error }, "square terminal checkout refresh failed");
      const row = await readTerminalCheckout(db, {
        businessId: context.businessId, checkoutId: id
      });
      return reply.code(502).send({
        code: "SQUARE_REFRESH_FAILED",
        error: error instanceof SquareApiError && error.code === "not_found"
          ? "Square no longer has a record of this terminal payment; it keeps them for thirty days."
          : "Square could not be reached. Nothing was changed; try again.",
        checkout: await presentCheckout(row!)
      });
    }
    const row = await readTerminalCheckout(db, { businessId: context.businessId, checkoutId: id });
    return presentCheckout(row!);
  });

  /**
   * Cancels a checkout on the terminal.
   *
   * Cancelling is a request, not a result. Square may already have taken the payment, in which case
   * the cancel is refused and reconciliation posts it - Square wins, and there is still exactly one
   * payment. So this route never writes `canceled` on its own authority: it asks Square, reconciles,
   * and reports whatever came back.
   */
  app.post("/api/square/terminal-checkouts/:id/cancel", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const { id } = idParams.parse(request.params);
    const existing = await readTerminalCheckout(db, {
      businessId: context.businessId, checkoutId: id
    });
    if (!existing) return reply.code(404).send({ error: "Terminal payment not found" });
    if (!existing.squareCheckoutId) {
      await db.begin(async (tx) => {
        await setTenant(tx, context.businessId);
        // Never reached Square, so there is nothing there to cancel and nothing that could have
        // taken money. Failing it locally is the honest end.
        await markCheckoutFailed(tx, {
          businessId: context.businessId, checkoutId: id,
          reason: "Cancelled before the terminal was reached."
        });
        await record(tx, {
          businessId: context.businessId, actorId: context.userId,
          action: "integration.square.checkout.cancel", resourceType: "square_terminal_checkout",
          resourceId: id, after: { reachedSquare: false }
        });
      });
      const row = await readTerminalCheckout(db, { businessId: context.businessId, checkoutId: id });
      return presentCheckout(row!);
    }
    let refused = false;
    try {
      const outcome = await withSquareAccess(db, dependencies(settings), context.businessId,
        async (token) => client(settings).cancelTerminalCheckout({
          accessToken: token, checkoutId: existing.squareCheckoutId!
        }));
      refused = !outcome.ok;
    } catch (error) {
      // A cancel Square refused because the payment had already gone through is not an error to
      // report to the operator - it is the case where the truth is at Square, and the reconcile
      // below is what finds it.
      request.log.info({ err: error }, "square terminal checkout cancel refused");
      refused = true;
    }
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "integration.square.checkout.cancel", resourceType: "square_terminal_checkout",
        resourceId: id, after: { reachedSquare: true, refused }
      });
    });
    try {
      await reconcileCheckout(db, dependencies(settings), {
        businessId: context.businessId, checkoutId: id
      });
    } catch (error) {
      request.log.warn({ err: error }, "square terminal checkout cancel reconciliation failed");
    }
    const row = await readTerminalCheckout(db, { businessId: context.businessId, checkoutId: id });
    return presentCheckout(row!);
  });

  // ---------------------------------------------------------------------------
  // Refunds.
  //
  // Gated on `checkout.perform`, the same permission that takes the money and the same one that
  // voids a record - deliberately, because a salon that trusts somebody to run a till trusts them
  // to correct it, and inventing a `payments.refund` permission here would leave every existing
  // membership unable to do the correction until an owner went and granted it.
  //
  // Nothing here accepts an amount for the tip, a Square refund id, or a provider. The payment is
  // named by the path; everything about it is read from the row.
  // ---------------------------------------------------------------------------

  /**
   * A refund as a screen may see it.
   *
   * `settled` is the only thing a client may render as "refunded", and only a retrieved Refund
   * reporting COMPLETED produces it. There is no Square refund id in here: a screen has no use for
   * one, and a value a client holds is a value a client can send back.
   */
  function presentRefund(row: PaymentRefundRow) {
    return {
      id: row.id,
      paymentId: row.paymentId,
      invoiceId: row.invoiceId,
      amountMinor: row.amountMinor,
      tipRefundedMinor: row.tipRefundedMinor,
      currency: row.currency,
      status: row.status,
      reason: row.reason,
      createdAt: row.createdAt,
      settledAt: row.settledAt,
      failureReason: row.failureReason,
      ...refundPresentation(row)
    };
  }

  /**
   * What is still refundable against a payment, and how much of that is tip.
   *
   * `serviceRemainingMinor` is the number that lets a screen show the tip line honestly without
   * re-implementing the tip-last rule: the tip portion of a refund of X is
   * `max(0, X - serviceRemainingMinor)`, and the rule itself - the service amount absorbs a refund
   * first - lives entirely in how the server computed that one figure. The server recomputes the
   * authoritative split under a lock when the refund is claimed; this is only what the operator is
   * shown before they confirm.
   */
  async function refundState(businessId: string, paymentId: string) {
    const [payment] = await db<{
      amountMinor: number; status: string; provider: string | null;
      providerTipMinor: number | null; currency: string;
    }[]>`
      select p.amount_minor, p.status, p.provider, p.provider_tip_minor, b.currency
      from payments p join businesses b on b.id=p.business_id
      where p.business_id=${businessId} and p.id=${paymentId}
    `;
    if (!payment) return null;
    const refunds = await listPaymentRefunds(db, { businessId, paymentId });
    // Pending refunds count. They have moved no money, but the money is spoken for, and a screen
    // that offered it again would be inviting a second refund of the same funds.
    const committedMinor = refunds
      .filter((refund) => refund.status !== "failed")
      .reduce((sum, refund) => sum + refund.amountMinor, 0);
    const tipMinor = payment.providerTipMinor ?? 0;
    const serviceTotal = Math.max(0, payment.amountMinor - tipMinor);
    return {
      paymentId,
      refundable: payment.status === "recorded" && Boolean(payment.provider),
      paymentAmountMinor: payment.amountMinor,
      paymentTipMinor: tipMinor,
      currency: payment.currency,
      refundedMinor: refunds
        .filter((refund) => refund.status === "completed")
        .reduce((sum, refund) => sum + refund.amountMinor, 0),
      refundableMinor: Math.max(0, payment.amountMinor - committedMinor),
      serviceRemainingMinor: Math.max(0, serviceTotal - committedMinor),
      refunds: refunds.map(presentRefund)
    };
  }

  const refundRefusals = {
    payment_not_found: { status: 404, code: "PAYMENT_NOT_FOUND", error: "Payment not found" },
    payment_voided: {
      status: 409, code: "PAYMENT_VOIDED",
      error: "This payment record was voided, so there is nothing to refund."
    },
    payment_not_refundable: {
      status: 409, code: "PAYMENT_NOT_REFUNDABLE",
      error: "Pawsh did not take this payment through a card terminal, so it cannot send money "
        + "back. Void the record instead and return the money the way it was taken."
    },
    refund_exceeds_remaining: {
      status: 409, code: "REFUND_EXCEEDS_REMAINING",
      error: "That is more than is left to refund on this payment."
    },
    currency_unknown: {
      status: 409, code: "BUSINESS_CURRENCY_UNKNOWN",
      error: "This salon has no valid currency set, so a refund cannot be sent."
    }
  } as const;

  /**
   * Whether a Square failure on the way to a refund leaves the attempt alive or kills it.
   *
   * The asymmetry is deliberate and it runs one way: a refund left `pending` holds its headroom and
   * therefore cannot become two refunds, while a refund marked `failed` releases that headroom and
   * invites somebody to try again. So the only failures that fail a refund are the ones where
   * Square has plainly told us it did not and will not create one. Anything ambiguous - a timeout,
   * a dropped connection, a body we could not parse, a key Square says it has seen before - stays
   * pending, because Square may well have moved the money and a retry of the SAME stored key will
   * find that out rather than refunding again.
   */
  function refundFailureIsFinal(error: unknown): boolean {
    if (!(error instanceof SquareApiError)) return false;
    return ["invalid_request", "not_found", "forbidden", "insufficient_scopes"]
      .includes(error.code);
  }

  function refundFailureMessage(error: unknown): string {
    if (!(error instanceof SquareApiError)) {
      return "The refund could not be confirmed. Check back in a moment before trying again.";
    }
    switch (error.code) {
      case "timeout":
      case "network_failure":
      case "square_unavailable":
        return "Square could not be reached. The refund may still be going through; check back in "
          + "a moment rather than starting another.";
      case "rate_limited":
        return "Square is busy. The refund may still be going through; check back in a moment.";
      case "not_found":
        return "Square no longer has a record of this payment, so it cannot be refunded here.";
      case "insufficient_scopes":
        return "Square has not granted Pawsh permission to refund payments. Reconnect Square.";
      case "invalid_request":
        return "Square refused the refund. Nothing was returned to the customer.";
      case "idempotency_key_reused":
        return "Pawsh sent a conflicting request for this refund. Nothing further was sent; tell "
          + "your administrator before trying again.";
      default:
        return "The refund could not be confirmed. Check back in a moment before trying again.";
    }
  }

  /**
   * What can still be refunded, and every refund already asked for.
   *
   * No Square call, so a screen may ask often - the same discipline the checkout read follows.
   */
  app.get("/api/payments/:id/refunds", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const state = await refundState(context.businessId, id);
    if (!state) return reply.code(404).send({ error: "Payment not found" });
    return state;
  });

  /**
   * Sends money back.
   *
   * The order is the whole correctness argument, and it is the checkout's order exactly. The local
   * row is claimed first, inside a transaction that locks the PAYMENT - which is what makes the sum
   * ceiling an enforcement rather than an estimate, because two concurrent refunds of one payment
   * serialise there instead of each finding the same headroom. The amount is checked against what
   * is left, the tip split is computed from the running position, and the idempotency key is
   * derived from facts that are now on disk. Square is called second. If that response is lost, the
   * row survives with its key, and a refresh re-sends the same key rather than refunding twice.
   *
   * NOTHING IS REPORTED AS REFUNDED UNTIL THE RETRIEVED REFUND SAYS COMPLETED. The create response
   * names the refund; the read says whether the money moved. `reconcileRefund` does both, and it is
   * the same function the webhook drain and the refresh route call, so a salon pressing a button
   * cannot reach an outcome the worker could not have reached on its own.
   */
  app.post("/api/payments/:id/refunds", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const { id } = idParams.parse(request.params);
    const input = paymentRefundSchema.parse(request.body);
    const requestKey = idempotencyKey(request);
    const reason = input.reason?.trim() || null;
    const requestHash = canonicalHash({
      version: 1, paymentId: id, amountMinor: input.amountMinor,
      expectedRefundableMinor: input.expectedRefundableMinor, reason
    });

    const claim = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const financial = await claimFinancialRequest(tx, {
        businessId: context.businessId, actorId: context.userId,
        operation: "payment.refund", key: requestKey, hash: requestHash
      });
      // A replayed request - a double-tapped button, a retried fetch - is answered with the refund
      // it already produced. It does not produce a second one.
      if (financial.existingResult) {
        return { replayed: true as const, result: financial.existingResult };
      }
      const outcome = await claimPaymentRefund(tx, {
        businessId: context.businessId, paymentId: id, amountMinor: input.amountMinor,
        reason, userId: context.userId
      });
      if (!outcome.claimed) {
        const refusal = refundRefusals[outcome.reason];
        // Thrown rather than returned, so the whole transaction - the financial claim included -
        // rolls back and the key is free for the corrected request the operator is about to make.
        throw new FinancialRequestError(
          refusal.status, refusal.code,
          outcome.reason === "refund_exceeds_remaining"
            && input.expectedRefundableMinor !== outcome.remainingMinor
            ? "Someone else refunded part of this payment while this was open. "
              + "Check what is left before refunding again."
            : refusal.error,
          { remainingMinor: outcome.remainingMinor }
        );
      }
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "payment.refund.request", resourceType: "payment_refund",
        resourceId: outcome.refund.id, reason,
        after: {
          paymentId: id, invoiceId: outcome.refund.invoiceId,
          amountMinor: outcome.refund.amountMinor,
          tipRefundedMinor: outcome.refund.tipRefundedMinor,
          currency: outcome.refund.currency, attempt: outcome.refund.attempt
        }
      });
      await completeFinancialRequest(tx, {
        id: financial.id, resultType: "payment_refund", resourceId: outcome.refund.id,
        result: presentRefund(outcome.refund)
      });
      return { replayed: false as const, refund: outcome.refund };
    });
    if (claim.replayed) return reply.code(200).send(claim.result);

    try {
      await reconcileRefund(db, dependencies(settings), {
        businessId: context.businessId, refundId: claim.refund.id
      });
    } catch (error) {
      request.log.warn({ err: error }, "square refund could not be confirmed");
      const message = refundFailureMessage(error);
      const final = refundFailureIsFinal(error);
      await db.begin(async (tx) => {
        await setTenant(tx, context.businessId);
        if (final) {
          await tx`
            update payment_refunds set status='failed', failure_reason=${message.slice(0, 500)}
            where business_id=${context.businessId} and id=${claim.refund.id} and status='pending'
          `;
          await record(tx, {
            businessId: context.businessId, actorId: context.userId,
            action: "payment.refund.failed", resourceType: "payment_refund",
            resourceId: claim.refund.id,
            before: { status: "pending" }, after: { status: "failed", failureReason: message }
          });
        } else {
          // Left pending on purpose. Square may have taken the money, and the stored key is what
          // makes finding out safe.
          await tx`
            update payment_refunds set failure_reason=${message.slice(0, 500)}
            where business_id=${context.businessId} and id=${claim.refund.id} and status='pending'
          `;
        }
      });
      const row = await readPaymentRefund(db, {
        businessId: context.businessId, refundId: claim.refund.id
      });
      return reply.code(final ? 502 : 503).send({
        code: final ? "SQUARE_REFUND_REFUSED" : "SQUARE_REFUND_UNCONFIRMED",
        error: message,
        refund: row ? presentRefund(row) : null
      });
    }

    const row = await readPaymentRefund(db, {
      businessId: context.businessId, refundId: claim.refund.id
    });
    return reply.code(201).send(presentRefund(row!));
  });

  /**
   * Recovery: re-read this refund from Square and apply what it says now.
   *
   * The same code the drain runs, for the webhook that never arrived. It also finishes a refund
   * whose create never got an answer, because `reconcileRefund` re-sends the stored key in that
   * case and Square returns the refund it already made rather than a second one.
   */
  app.post("/api/payment-refunds/:id/refresh", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    if (!availability.available) {
      return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
    }
    const context = auth(request);
    const settings = availability.settings;
    const { id } = idParams.parse(request.params);
    const existing = await readPaymentRefund(db, {
      businessId: context.businessId, refundId: id
    });
    if (!existing) return reply.code(404).send({ error: "Refund not found" });
    try {
      await reconcileRefund(db, dependencies(settings), {
        businessId: context.businessId, refundId: id
      });
    } catch (error) {
      request.log.warn({ err: error }, "square refund refresh failed");
      const row = await readPaymentRefund(db, { businessId: context.businessId, refundId: id });
      return reply.code(502).send({
        code: "SQUARE_REFUND_REFRESH_FAILED",
        error: refundFailureMessage(error),
        refund: row ? presentRefund(row) : null
      });
    }
    const row = await readPaymentRefund(db, { businessId: context.businessId, refundId: id });
    return presentRefund(row!);
  });

  // ---------------------------------------------------------------------------
  // The webhook receiver.
  //
  // Its own encapsulated scope so the raw-body parser reaches this route and nothing else. The
  // handler verifies, files and answers; it decides nothing, because Square is timing us.
  // ---------------------------------------------------------------------------

  void app.register(async (scope) => {
    // The inherited JSON parser would hand this route a parsed object and throw the bytes away,
    // and no re-serialisation reproduces them. Dropping every parser inside this scope - and only
    // inside it - leaves one catch-all that keeps the Buffer, whatever content type Square sends.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });

    scope.post("/webhooks/square", async (request, reply) => {
      if (!availability.available) {
        return reply.code(503).send({ code: squareUnavailableCode, error: availability.reason });
      }
      const settings = availability.settings;
      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        return reply.code(400).send({ error: "A Square notification must have a body" });
      }
      const header = request.headers[squareSignatureHeader];
      const signature = typeof header === "string" ? header : undefined;
      const verified = verifySquareSignature({
        // The configured string, never the inbound Host header.
        notificationUrl: settings.notificationUrl,
        rawBody,
        signature,
        signatureKey: settings.webhookSignatureKey
      });
      if (!verified) {
        request.log.warn({ securityEvent: "square.webhook.signature_rejected" }, "security event");
        return reply.code(401).send({ error: "Signature verification failed" });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "A Square notification must be JSON" });
      }
      const envelope = parseWebhookEnvelope(payload);
      if (!envelope) {
        return reply.code(400).send({ error: "A Square notification must carry an event id, merchant and type" });
      }

      const accepted = await recordWebhookEvent(db, { envelope, payload });
      // A redelivery is Square working correctly, so it is acknowledged rather than refused.
      return reply.code(200).send({
        status: accepted.duplicate ? "duplicate" : "recorded",
        eventId: accepted.eventId
      });
    });
  });
}
