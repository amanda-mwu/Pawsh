import type { z } from "zod";
import {
  SquareApiError, squareErrorCode, squareErrorMessage, type SquareApiErrorDetail
} from "./errors.js";
import {
  squareDeviceCodeResponseSchema, squareEmptySchema, squareErrorBodySchema, squareLocationsSchema,
  squareMerchantSchema, squarePaymentResponseSchema, squareRefundResponseSchema,
  squareTerminalCheckoutResponseSchema, squareTokenSchema, squareTokenStatusSchema,
  type SquareDeviceCode, type SquarePayment, type SquareRefund, type SquareTerminalCheckout
} from "./schemas.js";

/**
 * The only place in Pawsh that calls `fetch` for Square.
 *
 * One seam, for two reasons that pull in the same direction. The first is testing: the unit
 * suite is the tier that gates every push here, so the invariants worth protecting have to be
 * reachable without a network. Injecting a fixture-backed transport into this one constructor
 * does that; patching the global `fetch` would leak across test files, would not survive a
 * runtime that changes how `fetch` is resolved, and would let a second call site appear
 * elsewhere without anybody noticing. The second is discipline: version pinning, timeouts, error
 * mapping and response parsing are properties of every Square call, and a second call site is a
 * second place for one of them to be forgotten.
 *
 * SQUARE-VERSION IS PINNED IN CODE. Omitting the header does not mean "latest" - it means the
 * version configured on the Square application, which somebody can change in a dashboard,
 * without a deploy, and without telling us. A response shape changing under a running service is
 * exactly the failure this integration cannot absorb quietly, so the version is a constant here
 * and the fixture suite asserts the recorded bodies were captured against the same one.
 *
 * OAUTH IS NOT UNDER /v2. `/oauth2/authorize` and `/oauth2/token` sit at the host root while
 * every other endpoint sits under `/v2`, which is why this module keeps the host and the API
 * prefix as separate strings rather than one base URL.
 */

export const squareApiVersion = "2026-08-19";

export type SquareEnvironment = "sandbox" | "production";

const hosts: Record<SquareEnvironment, string> = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com"
};

/**
 * The scopes Pawsh asks for, and nothing beyond them.
 *
 * PAYMENTS_WRITE_IN_PERSON is deliberately absent: it authorises the in-person Reader SDK, where
 * the card is read by an application we ship. Terminal checkouts are taken by Square's own
 * hardware and authorised by PAYMENTS_WRITE, so asking for the Reader scope would be asking a
 * salon to grant a capability we neither use nor want to be able to use.
 * PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS is absent for the same reason - it authorises splitting
 * a payment to another Square account, which this product does not do.
 */
export const squareScopes = [
  "PAYMENTS_READ",
  "PAYMENTS_WRITE",
  "DEVICE_CREDENTIAL_MANAGEMENT",
  "MERCHANT_PROFILE_READ"
] as const;

export type SquareFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SquareClientOptions {
  environment: SquareEnvironment;
  applicationId: string;
  applicationSecret: string;
  /** Injected by tests. Defaults to the runtime's global `fetch`. */
  fetchImplementation?: SquareFetch;
  /**
   * Whole-request ceiling, mirroring how `storage/documents.ts` bounds its S3 handler rather
   * than trusting a default. `fetch` has no separate connect timeout to set, so this covers
   * connection, transmission and body read together.
   */
  timeoutMs?: number;
}

export interface SquareTokenGrant {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  merchantId: string;
}

export interface SquareMerchant {
  id: string;
  businessName: string | null;
  country: string | null;
  currency: string | null;
  status: string | null;
  mainLocationId: string | null;
}

export interface SquareLocation {
  id: string;
  name: string | null;
  status: string | null;
  currency: string | null;
  timezone: string | null;
}

export interface SquareTokenGrantStatus {
  scopes: string[];
  expiresAt: Date | null;
  merchantId: string | null;
}

/**
 * What a Terminal checkout asks for.
 *
 * There is no amount field a caller could supply from a request body by accident: the amount is a
 * number this type demands and `startTerminalCheckout` derives from the invoice. `idempotencyKey`
 * is likewise required and is never defaulted here - a client that forgot it would otherwise get
 * a fresh key and a second charge, so the omission has to be a type error rather than a runtime
 * convenience.
 */
export interface SquareTerminalCheckoutRequest {
  accessToken: string;
  idempotencyKey: string;
  deviceId: string;
  amountMinor: number;
  currency: string;
  /** The Pawsh invoice id. Reconciliation metadata; Square caps it at 40 characters. */
  referenceId: string;
  tipPercentages: readonly number[];
}

/**
 * What a refund asks for.
 *
 * `idempotencyKey` is required and never defaulted, for the same reason it is on a checkout: a
 * caller that forgot it would otherwise get a fresh key and a second refund, and that has to be a
 * type error rather than a runtime convenience. Square caps this one at 45 characters - Terminal
 * allows 64 - so the two derivations are deliberately separate functions rather than one shared
 * generator whose output happens to fit today.
 *
 * `paymentVersionToken` comes from the RETRIEVED Payment, never from anything we stored. It is
 * Square's optimistic-concurrency check: if the payment moved between our read and our refund,
 * Square refuses rather than refunding against a version we were no longer looking at.
 */
export interface SquareRefundRequest {
  accessToken: string;
  idempotencyKey: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  reason?: string | undefined;
  paymentVersionToken?: string | undefined;
}

export interface SquareClient {
  readonly environment: SquareEnvironment;
  readonly apiVersion: string;
  /** The URL a salon owner is sent to. Nothing secret is in it; `state` is ours and single-use. */
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  exchangeAuthorizationCode(input: { code: string; redirectUri: string }): Promise<SquareTokenGrant>;
  refreshAccessToken(input: { refreshToken: string }): Promise<SquareTokenGrant>;
  revokeAccessToken(input: { accessToken: string }): Promise<void>;
  retrieveTokenStatus(input: { accessToken: string }): Promise<SquareTokenGrantStatus>;
  retrieveMerchant(input: { accessToken: string; merchantId: string }): Promise<SquareMerchant>;
  listLocations(input: { accessToken: string }): Promise<SquareLocation[]>;
  createDeviceCode(input: {
    accessToken: string;
    idempotencyKey: string;
    squareLocationId: string;
    name: string;
  }): Promise<SquareDeviceCode>;
  retrieveDeviceCode(input: { accessToken: string; deviceCodeId: string }): Promise<SquareDeviceCode>;
  createTerminalCheckout(input: SquareTerminalCheckoutRequest): Promise<SquareTerminalCheckout>;
  retrieveTerminalCheckout(input: {
    accessToken: string; checkoutId: string;
  }): Promise<SquareTerminalCheckout>;
  cancelTerminalCheckout(input: {
    accessToken: string; checkoutId: string;
  }): Promise<SquareTerminalCheckout>;
  retrievePayment(input: { accessToken: string; paymentId: string }): Promise<SquarePayment>;
  createRefund(input: SquareRefundRequest): Promise<SquareRefund>;
  retrieveRefund(input: { accessToken: string; refundId: string }): Promise<SquareRefund>;
}

export function createSquareClient(options: SquareClientOptions): SquareClient {
  const host = hosts[options.environment];
  const transport = options.fetchImplementation ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(input: {
    method: "GET" | "POST";
    path: string;
    schema: z.ZodType<T>;
    accessToken?: string;
    /** `Client <secret>` rather than `Bearer <token>`: the revoke endpoint authenticates the app. */
    clientAuthorization?: boolean;
    body?: unknown;
  }): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Square-Version": squareApiVersion
    };
    if (input.clientAuthorization) headers.Authorization = `Client ${options.applicationSecret}`;
    else if (input.accessToken) headers.Authorization = `Bearer ${input.accessToken}`;

    let response: Response;
    try {
      const init: RequestInit = {
        method: input.method,
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      };
      if (input.body !== undefined) init.body = JSON.stringify(input.body);
      response = await transport(`${host}${input.path}`, init);
    } catch (error) {
      const aborted = error instanceof Error
        && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new SquareApiError(
        aborted ? "timeout" : "network_failure",
        aborted ? "Square did not answer within the request timeout" : "Square could not be reached",
        null
      );
    }

    const text = await response.text().catch(() => "");
    let parsedBody: unknown = {};
    if (text.trim()) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        throw new SquareApiError("malformed_response", "Square returned a body that is not JSON", response.status);
      }
    }

    if (!response.ok) {
      const errors: SquareApiErrorDetail[] = squareErrorBodySchema.safeParse(parsedBody).data?.errors ?? [];
      const code = squareErrorCode(response.status, errors);
      throw new SquareApiError(code, squareErrorMessage(code, errors), response.status, errors);
    }

    const parsed = input.schema.safeParse(parsedBody);
    if (!parsed.success) {
      // A 200 whose shape we do not recognise is not a success. Returning it would push the
      // surprise into whichever caller first read a field that is no longer there.
      throw new SquareApiError(
        "malformed_response",
        "Square returned a body that does not match the expected shape",
        response.status
      );
    }
    return parsed.data;
  }

  function grant(token: z.infer<typeof squareTokenSchema>): SquareTokenGrant {
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: parseTimestamp(token.expires_at),
      merchantId: token.merchant_id
    };
  }

  return {
    environment: options.environment,
    apiVersion: squareApiVersion,

    authorizeUrl(input) {
      const url = new URL("/oauth2/authorize", host);
      url.searchParams.set("client_id", options.applicationId);
      url.searchParams.set("scope", squareScopes.join(" "));
      url.searchParams.set("state", input.state);
      url.searchParams.set("redirect_uri", input.redirectUri);
      // Square reuses an existing authorisation silently when this is absent, which makes a
      // scope change invisible to the merchant who has to approve it.
      url.searchParams.set("session", "false");
      return url.toString();
    },

    async exchangeAuthorizationCode(input) {
      return grant(await call({
        method: "POST",
        path: "/oauth2/token",
        schema: squareTokenSchema,
        body: {
          client_id: options.applicationId,
          client_secret: options.applicationSecret,
          code: input.code,
          grant_type: "authorization_code",
          redirect_uri: input.redirectUri
        }
      }));
    },

    async refreshAccessToken(input) {
      return grant(await call({
        method: "POST",
        path: "/oauth2/token",
        schema: squareTokenSchema,
        body: {
          client_id: options.applicationId,
          client_secret: options.applicationSecret,
          grant_type: "refresh_token",
          refresh_token: input.refreshToken
        }
      }));
    },

    async revokeAccessToken(input) {
      await call({
        method: "POST",
        path: "/oauth2/revoke",
        schema: squareEmptySchema,
        clientAuthorization: true,
        body: { client_id: options.applicationId, access_token: input.accessToken }
      });
    },

    async retrieveTokenStatus(input) {
      const status = await call({
        method: "POST",
        path: "/oauth2/token/status",
        schema: squareTokenStatusSchema,
        accessToken: input.accessToken
      });
      return {
        scopes: status.scopes ?? [],
        expiresAt: parseTimestamp(status.expires_at),
        merchantId: status.merchant_id ?? null
      };
    },

    async retrieveMerchant(input) {
      const body = await call({
        method: "GET",
        path: `/v2/merchants/${encodeURIComponent(input.merchantId)}`,
        schema: squareMerchantSchema,
        accessToken: input.accessToken
      });
      return {
        id: body.merchant.id,
        businessName: body.merchant.business_name ?? null,
        country: body.merchant.country ?? null,
        currency: body.merchant.currency ?? null,
        status: body.merchant.status ?? null,
        mainLocationId: body.merchant.main_location_id ?? null
      };
    },

    async listLocations(input) {
      const body = await call({
        method: "GET",
        path: "/v2/locations",
        schema: squareLocationsSchema,
        accessToken: input.accessToken
      });
      return body.locations.map((location) => ({
        id: location.id,
        name: location.name ?? null,
        status: location.status ?? null,
        currency: location.currency ?? null,
        timezone: location.timezone ?? null
      }));
    },

    /**
     * Asks Square for a pairing code the salon types into the terminal.
     *
     * `product_type` is pinned to TERMINAL_API in code. It is the field that decides what the
     * paired device will accept, and a code issued for the wrong product type pairs successfully
     * and then refuses every checkout - a failure that would surface at a counter with a customer
     * waiting, which is the worst possible place to discover a request parameter.
     *
     * No expiry is passed and none is assumed. The response carries `pair_by` and that instant is
     * what gets stored; how long Square chooses to make a code live is Square's to change.
     */
    async createDeviceCode(input) {
      const body = await call({
        method: "POST",
        path: "/v2/devices/codes",
        schema: squareDeviceCodeResponseSchema,
        accessToken: input.accessToken,
        body: {
          idempotency_key: input.idempotencyKey,
          device_code: {
            product_type: "TERMINAL_API",
            location_id: input.squareLocationId,
            name: input.name
          }
        }
      });
      return body.device_code;
    },

    /**
     * Re-reads a device code.
     *
     * `device.code.paired` is the production path and this is the recovery one: a webhook can be
     * missed, and a salon staring at a terminal that says it is paired must have some way to make
     * Pawsh agree without waiting for a redelivery.
     */
    async retrieveDeviceCode(input) {
      const body = await call({
        method: "GET",
        path: `/v2/devices/codes/${encodeURIComponent(input.deviceCodeId)}`,
        schema: squareDeviceCodeResponseSchema,
        accessToken: input.accessToken
      });
      return body.device_code;
    },

    /**
     * Starts a checkout on a paired terminal.
     *
     * `idempotency_key` is the caller's, unchanged. Square answers a repeat of the same key with
     * the checkout it already created rather than creating a second, which is the entire defence
     * against a retry after a network failure becoming a second charge - so this method must never
     * mint, salt or decorate the key it was given.
     *
     * `reference_id` carries the Pawsh invoice id so a person reading Square's dashboard can find
     * the invoice. It is metadata: nothing in reconciliation trusts it, because a value we send
     * and Square echoes proves only that we sent it.
     *
     * `tip_settings` pushes the salon's own three presets to the device, so the tip is offered in
     * one place - the terminal - rather than configured once in Pawsh and again on the hardware.
     */
    async createTerminalCheckout(input) {
      const body = await call({
        method: "POST",
        path: "/v2/terminals/checkouts",
        schema: squareTerminalCheckoutResponseSchema,
        accessToken: input.accessToken,
        body: {
          idempotency_key: input.idempotencyKey,
          checkout: {
            amount_money: { amount: input.amountMinor, currency: input.currency },
            reference_id: input.referenceId,
            device_options: { device_id: input.deviceId },
            tip_settings: {
              allow_tipping: input.tipPercentages.length > 0,
              separate_tip_screen: input.tipPercentages.length > 0,
              tip_percentages: [...input.tipPercentages]
            }
          }
        }
      });
      return body.checkout;
    },

    /**
     * Re-reads a checkout. Recovery, not a polling loop.
     *
     * Square retains Terminal checkouts for thirty days, so this can answer `not_found` for a real
     * checkout that simply aged out. Callers must treat that as "no longer knowable" rather than
     * as "never happened": the payment, if there was one, is in `payments` and is not affected by
     * Square forgetting the intent that produced it.
     */
    async retrieveTerminalCheckout(input) {
      const body = await call({
        method: "GET",
        path: `/v2/terminals/checkouts/${encodeURIComponent(input.checkoutId)}`,
        schema: squareTerminalCheckoutResponseSchema,
        accessToken: input.accessToken
      });
      return body.checkout;
    },

    async cancelTerminalCheckout(input) {
      const body = await call({
        method: "POST",
        path: `/v2/terminals/checkouts/${encodeURIComponent(input.checkoutId)}/cancel`,
        schema: squareTerminalCheckoutResponseSchema,
        accessToken: input.accessToken
      });
      return body.checkout;
    },

    /**
     * The retrieved Payment: the only financial authority in this integration.
     *
     * A checkout that says COMPLETED is a wake-up. This is the thing that says how much money
     * moved, in what currency, and whether it actually settled.
     */
    async retrievePayment(input) {
      const body = await call({
        method: "GET",
        path: `/v2/payments/${encodeURIComponent(input.paymentId)}`,
        schema: squarePaymentResponseSchema,
        accessToken: input.accessToken
      });
      return body.payment;
    },

    /**
     * Refunds part or all of a payment.
     *
     * THIS IS THE REFUNDS API, NOT `CreateTerminalRefund`. The Terminal refund endpoint exists,
     * and it is not this: it is Interac-only, which is to say Canadian debit, and it is not what a
     * US card-present Terminal payment is refunded through. Sending a Terminal payment there
     * fails, and it fails in a way that looks like a configuration problem rather than a wrong
     * endpoint. `POST /v2/refunds` refunds any payment, card-present included, in full or in part.
     *
     * `idempotency_key` is the caller's, unchanged and undecorated. Square answers a repeat of the
     * same key with the refund it already created rather than refunding twice, which is the whole
     * defence against a lost response becoming a second refund - so this method must never mint,
     * salt or truncate the key it was given.
     *
     * `reason` is the operator's own sentence, forwarded so it shows in Square's dashboard beside
     * ours. It is metadata; nothing branches on it.
     */
    async createRefund(input) {
      const body = await call({
        method: "POST",
        path: "/v2/refunds",
        schema: squareRefundResponseSchema,
        accessToken: input.accessToken,
        body: {
          idempotency_key: input.idempotencyKey,
          amount_money: { amount: input.amountMinor, currency: input.currency },
          payment_id: input.paymentId,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.paymentVersionToken
            ? { payment_version_token: input.paymentVersionToken }
            : {})
        }
      });
      return body.refund;
    },

    /**
     * The retrieved Refund: the only authority on whether money actually went back.
     *
     * A `refund.updated` event is a wake-up call, exactly as `terminal.checkout.updated` is. It is
     * a notification we did not author, delivered over a channel that retries, describing an
     * object we have not read. This is the read.
     */
    async retrieveRefund(input) {
      const body = await call({
        method: "GET",
        path: `/v2/refunds/${encodeURIComponent(input.refundId)}`,
        schema: squareRefundResponseSchema,
        accessToken: input.accessToken
      });
      return body.refund;
    }
  };
}

function parseTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
