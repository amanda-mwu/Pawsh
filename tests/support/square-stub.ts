import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  SquareClient, SquareLocation, SquareTerminalCheckoutRequest
} from "../../src/integrations/square/client.js";
import { SquareApiError } from "../../src/integrations/square/errors.js";
import type {
  SquareDeviceCode, SquarePayment, SquareRefund, SquareTerminalCheckout
} from "../../src/integrations/square/schemas.js";

/**
 * A Square that answers from fixtures and never touches the network.
 *
 * NO SQUARE CREDENTIALS EXIST FOR THIS PROJECT, so there is no sandbox run behind any of these
 * tests and nothing here should ever be described as sandbox-verified. What this stub buys is the
 * only thing a stub can honestly buy: every branch of the production code path - the routes, the
 * reconciler, the drain, the transaction - runs for real against a real database, with Square's
 * shapes standing in for Square's answers.
 *
 * It is a small state machine rather than a bag of `vi.fn()`s on purpose. The properties worth
 * testing are sequences: create a checkout, complete it, replay the webhook, complete it again.
 * A mock that returns a canned value per call cannot express "the same idempotency key must come
 * back with the same checkout", which is the single most important thing in this integration.
 */

export interface SquareStubState {
  /** Every call, in order, so a test can assert what was sent as well as what came back. */
  calls: { method: string; input: unknown }[];
  deviceCodes: Map<string, SquareDeviceCode>;
  checkouts: Map<string, SquareTerminalCheckout>;
  /** Keyed by idempotency key: this is how the stub reproduces Square's own dedupe. */
  checkoutsByIdempotencyKey: Map<string, string>;
  payments: Map<string, SquarePayment>;
  refunds: Map<string, SquareRefund>;
  /** Keyed by idempotency key: this is how the stub reproduces Square's own refund dedupe. */
  refundsByIdempotencyKey: Map<string, string>;
  locations: SquareLocation[];
  /** One-shot failures, keyed by method name; consumed on the next call to that method. */
  failNext: Map<string, SquareApiError>;
  /** Standing failures, keyed by method name; every call to that method throws. */
  failAlways: Map<string, SquareApiError>;
  merchantId: string;
  accessToken: string;
  refreshToken: string;
  /** Set when a refresh has happened, so "refreshed and retried once" is observable. */
  refreshes: number;
  /**
   * What the next `POST /v2/refunds` reports. Mutable so one suite can drive a refund that
   * settles at once and a refund that stays pending without building a second application.
   */
  refundOutcome: string;
}

export interface SquareStub {
  client: SquareClient;
  state: SquareStubState;
  /** Moves a checkout on, the way a terminal would. */
  completeCheckout(input: {
    checkoutId: string; amountMinor: number; tipMinor: number; currency?: string;
    paymentId?: string; paymentStatus?: string;
  }): SquarePayment;
  cancelCheckout(input: { checkoutId: string; reason: string }): void;
  pairDeviceCode(input: { deviceCodeId: string; deviceId: string }): SquareDeviceCode;
  expireDeviceCode(deviceCodeId: string): void;
  /** Moves a refund on, the way Square's asynchronous settlement would. */
  settleRefund(input: { refundId: string; status: string; amountMinor?: number; currency?: string }): SquareRefund;
}

export function squareStub(options: {
  merchantId?: string;
  locations?: SquareLocation[];
  /** Advances by one on every access-token refresh, so a stale token can be simulated. */
  accessToken?: string;
  /**
   * What `POST /v2/refunds` reports on creation. Defaults to PENDING because that is what a real
   * card refund does: the create names the refund, and settlement happens afterwards. A test that
   * wants the settled path either passes "COMPLETED" or drives `settleRefund` itself.
   */
  refundOutcome?: string;
} = {}): SquareStub {
  const state: SquareStubState = {
    calls: [],
    deviceCodes: new Map(),
    checkouts: new Map(),
    checkoutsByIdempotencyKey: new Map(),
    payments: new Map(),
    refunds: new Map(),
    refundsByIdempotencyKey: new Map(),
    locations: options.locations ?? [
      { id: "LSAMPLE000000001", name: "Front Counter", status: "ACTIVE", currency: "USD", timezone: "UTC" },
      { id: "LSAMPLE000000002", name: "Mobile Van", status: "ACTIVE", currency: "USD", timezone: "UTC" }
    ],
    failNext: new Map(),
    failAlways: new Map(),
    merchantId: options.merchantId ?? "MLSAMPLE00000001",
    accessToken: options.accessToken ?? "EAAAl0SAMPLEsandboxACCESStoken0000000000000000000000",
    refreshToken: "EQAAl0SAMPLEsandboxREFRESHtoken000000000000000000000",
    refreshes: 0,
    refundOutcome: options.refundOutcome ?? "PENDING"
  };

  // The test database is reused between runs and `square_device_code_identifier` is unique across
  // the whole table, so a stub that counted from one would collide with yesterday's rows the
  // moment two files ran together. The run token keeps the sequence readable and still unique.
  const runToken = randomBytes(5).toString("hex").toUpperCase();
  let sequence = 0;
  function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}${runToken}${String(sequence).padStart(4, "0")}`;
  }

  function enter(method: string, input: unknown): void {
    state.calls.push({ method, input });
    const standing = state.failAlways.get(method);
    if (standing) throw standing;
    const once = state.failNext.get(method);
    if (once) {
      state.failNext.delete(method);
      throw once;
    }
  }

  const client: SquareClient = {
    environment: "sandbox",
    apiVersion: "2026-08-19",
    authorizeUrl: ({ state: value, redirectUri }) =>
      `https://connect.squareupsandbox.com/oauth2/authorize?client_id=test&state=${value}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`,

    async exchangeAuthorizationCode() {
      enter("exchangeAuthorizationCode", {});
      return {
        accessToken: state.accessToken, refreshToken: state.refreshToken,
        expiresAt: new Date("2026-09-29T18:22:41Z"), merchantId: state.merchantId
      };
    },

    async refreshAccessToken() {
      enter("refreshAccessToken", {});
      state.refreshes += 1;
      state.accessToken = `EAAAl0SAMPLEsandboxACCESStoken${String(state.refreshes).padStart(22, "0")}`;
      return {
        accessToken: state.accessToken, refreshToken: state.refreshToken,
        expiresAt: new Date("2026-10-29T18:22:41Z"), merchantId: state.merchantId
      };
    },

    async revokeAccessToken() {
      enter("revokeAccessToken", {});
    },

    async retrieveTokenStatus() {
      enter("retrieveTokenStatus", {});
      return {
        scopes: ["PAYMENTS_READ", "PAYMENTS_WRITE", "DEVICE_CREDENTIAL_MANAGEMENT", "MERCHANT_PROFILE_READ"],
        expiresAt: null, merchantId: state.merchantId
      };
    },

    async retrieveMerchant() {
      enter("retrieveMerchant", {});
      return {
        id: state.merchantId, businessName: "Sample Grooming Salon", country: "US",
        currency: "USD", status: "ACTIVE", mainLocationId: "LSAMPLE000000001"
      };
    },

    async listLocations() {
      enter("listLocations", {});
      return state.locations;
    },

    async createDeviceCode(input) {
      enter("createDeviceCode", input);
      const code: SquareDeviceCode = {
        id: nextId("DCSTUB"),
        code: `PW${runToken.slice(0, 4)}${String(sequence).padStart(2, "0")}`,
        location_id: input.squareLocationId,
        name: input.name,
        product_type: "TERMINAL_API",
        status: "UNPAIRED",
        pair_by: new Date(Date.now() + 5 * 60_000).toISOString(),
        created_at: new Date().toISOString()
      };
      state.deviceCodes.set(code.id, code);
      return code;
    },

    async retrieveDeviceCode(input) {
      enter("retrieveDeviceCode", input);
      const code = state.deviceCodes.get(input.deviceCodeId);
      if (!code) throw new SquareApiError("not_found", "Device code not found", 404);
      return code;
    },

    /**
     * Square's own idempotency, reproduced: the same key returns the checkout it already made.
     *
     * This is the behaviour the retry path depends on, so a test that never exercises it would be
     * asserting the key is stable without ever asserting the stability is worth anything.
     */
    async createTerminalCheckout(input: SquareTerminalCheckoutRequest) {
      enter("createTerminalCheckout", input);
      const seen = state.checkoutsByIdempotencyKey.get(input.idempotencyKey);
      if (seen) return state.checkouts.get(seen)!;
      const checkout: SquareTerminalCheckout = {
        id: nextId("CHKSTUB"),
        amount_money: { amount: input.amountMinor, currency: input.currency },
        reference_id: input.referenceId,
        device_options: { device_id: input.deviceId },
        status: "PENDING",
        payment_ids: [],
        created_at: new Date().toISOString()
      };
      state.checkouts.set(checkout.id, checkout);
      state.checkoutsByIdempotencyKey.set(input.idempotencyKey, checkout.id);
      return checkout;
    },

    async retrieveTerminalCheckout(input) {
      enter("retrieveTerminalCheckout", input);
      const checkout = state.checkouts.get(input.checkoutId);
      if (!checkout) throw new SquareApiError("not_found", "Checkout not found", 404);
      return checkout;
    },

    async cancelTerminalCheckout(input) {
      enter("cancelTerminalCheckout", input);
      const checkout = state.checkouts.get(input.checkoutId);
      if (!checkout) throw new SquareApiError("not_found", "Checkout not found", 404);
      if ((checkout.status ?? "") === "COMPLETED") {
        throw new SquareApiError("conflict", "Checkout is already completed", 409);
      }
      const cancelled = { ...checkout, status: "CANCELED", cancel_reason: "CANCELED_BY_SELLER" };
      state.checkouts.set(checkout.id, cancelled);
      return cancelled;
    },

    async retrievePayment(input) {
      enter("retrievePayment", input);
      const payment = state.payments.get(input.paymentId);
      if (!payment) throw new SquareApiError("not_found", "Payment not found", 404);
      return payment;
    },

    /**
     * Square's own refund idempotency, reproduced: the same key returns the refund it already made.
     *
     * This is the behaviour the whole retry path depends on. A stub that minted a second refund
     * for a repeated key would let the tests assert the key is stable without ever asserting the
     * stability is worth anything - which is exactly the assertion that matters, because the
     * failure it prevents is refunding a customer twice.
     */
    async createRefund(input) {
      enter("createRefund", input);
      const seen = state.refundsByIdempotencyKey.get(input.idempotencyKey);
      if (seen) return state.refunds.get(seen)!;
      const payment = state.payments.get(input.paymentId);
      if (!payment) throw new SquareApiError("not_found", "Payment not found", 404);
      // Square refuses a refund larger than the payment. Reproduced so a test can prove Pawsh
      // never gets that far rather than merely that Pawsh would survive it.
      const alreadyRefunded = [...state.refunds.values()]
        .filter((refund) => refund.payment_id === input.paymentId
          && (refund.status ?? "").toUpperCase() !== "REJECTED")
        .reduce((sum, refund) => sum + refund.amount_money.amount, 0);
      const charged = payment.total_money?.amount ?? payment.amount_money.amount;
      if (alreadyRefunded + input.amountMinor > charged) {
        throw new SquareApiError(
          "invalid_request", "Refund amount exceeds the payment", 400,
          [{ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST", detail: "refund too large" }]
        );
      }
      const refund: SquareRefund = {
        id: `${input.paymentId}_${nextId("RFND")}`,
        status: state.refundOutcome,
        amount_money: { amount: input.amountMinor, currency: input.currency },
        payment_id: input.paymentId,
        location_id: "LSAMPLE000000001",
        ...(input.reason ? { reason: input.reason } : {}),
        created_at: new Date().toISOString()
      };
      state.refunds.set(refund.id, refund);
      state.refundsByIdempotencyKey.set(input.idempotencyKey, refund.id);
      return refund;
    },

    async retrieveRefund(input) {
      enter("retrieveRefund", input);
      const refund = state.refunds.get(input.refundId);
      if (!refund) throw new SquareApiError("not_found", "Refund not found", 404);
      return refund;
    }
  };

  return {
    client,
    state,

    completeCheckout(input) {
      const checkout = state.checkouts.get(input.checkoutId);
      if (!checkout) throw new Error(`No stub checkout ${input.checkoutId}`);
      const currency = input.currency ?? checkout.amount_money.currency;
      const payment: SquarePayment = {
        id: input.paymentId ?? nextId("PAYSTUB"),
        status: input.paymentStatus ?? "COMPLETED",
        amount_money: { amount: input.amountMinor, currency },
        tip_money: { amount: input.tipMinor, currency },
        total_money: { amount: input.amountMinor + input.tipMinor, currency },
        version_token: `VER${runToken}${String(sequence).padStart(4, "0")}`,
        source_type: "CARD",
        location_id: "LSAMPLE000000001",
        terminal_checkout_id: checkout.id,
        created_at: new Date().toISOString()
      };
      state.payments.set(payment.id, payment);
      state.checkouts.set(checkout.id, {
        ...checkout,
        status: "COMPLETED",
        payment_ids: [...(checkout.payment_ids ?? []), payment.id],
        updated_at: new Date().toISOString()
      });
      return payment;
    },

    cancelCheckout(input) {
      const checkout = state.checkouts.get(input.checkoutId);
      if (!checkout) throw new Error(`No stub checkout ${input.checkoutId}`);
      state.checkouts.set(checkout.id, {
        ...checkout, status: "CANCELED", cancel_reason: input.reason,
        updated_at: new Date().toISOString()
      });
    },

    pairDeviceCode(input) {
      const code = state.deviceCodes.get(input.deviceCodeId);
      if (!code) throw new Error(`No stub device code ${input.deviceCodeId}`);
      const paired: SquareDeviceCode = {
        ...code, device_id: input.deviceId, status: "PAIRED",
        status_changed_at: new Date().toISOString()
      };
      state.deviceCodes.set(code.id, paired);
      return paired;
    },

    settleRefund(input) {
      const refund = state.refunds.get(input.refundId);
      if (!refund) throw new Error(`No stub refund ${input.refundId}`);
      const settled: SquareRefund = {
        ...refund,
        status: input.status,
        amount_money: {
          amount: input.amountMinor ?? refund.amount_money.amount,
          currency: input.currency ?? refund.amount_money.currency
        },
        updated_at: new Date().toISOString()
      };
      state.refunds.set(refund.id, settled);
      return settled;
    },

    expireDeviceCode(deviceCodeId) {
      const code = state.deviceCodes.get(deviceCodeId);
      if (!code) throw new Error(`No stub device code ${deviceCodeId}`);
      state.deviceCodes.set(code.id, {
        ...code, status: "EXPIRED",
        pair_by: new Date(Date.now() - 60_000).toISOString()
      });
    }
  };
}

/** The recorded webhook bodies, as the bytes the receiver must see. */
export async function squareFixture(name: string): Promise<Buffer> {
  return readFile(`tests/fixtures/square/${name}`);
}
