import type { Page, Route } from "@playwright/test";

/**
 * Pawsh-shaped Square responses, served to the browser by `page.route`.
 *
 * These stub PAWSH'S OWN endpoints, not Square's. The fixtures under tests/fixtures/square are
 * Square API payloads consumed server-side by tests/support/square-stub.ts; by the time a response
 * reaches app.js it has been through `presentDevice` / `presentCheckout`, so those files are the
 * wrong shape for a browser-level route and using them here would assert against a contract the
 * client never sees.
 *
 * Every field below mirrors `presentDevice` and `presentCheckout` in src/http/square-routes.ts and
 * `checkoutPresentation` in src/integrations/square/terminal.ts. Keep them in step: a stub that
 * drifts from the presenter tests nothing.
 *
 * No Square credentials are used and no request leaves the browser.
 */

export type PairingStatus = "paired" | "unpaired" | "expired";

export interface StubDevice {
  id: string;
  label: string;
  locationId: string | null;
  pairingStatus: PairingStatus;
  pairingCode: string | null;
  pairBy: string | null;
  pairedAt: string | null;
  createdAt: string;
}

export function stubDevice(overrides: Partial<StubDevice> & { id: string; label: string }): StubDevice {
  return {
    locationId: null,
    pairingStatus: "unpaired",
    pairingCode: null,
    pairBy: null,
    pairedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

/** A pairing code that is still inside its window, the way the server would hand one back. */
export function pairedCode(device: StubDevice, code: string): StubDevice {
  return {
    ...device,
    pairingStatus: "unpaired",
    pairingCode: code,
    pairBy: new Date(Date.now() + 10 * 60_000).toISOString()
  };
}

export interface SquareIntegrationState {
  configured?: boolean;
  reason?: string | null;
  status?: "connected" | "revoked" | "pending";
  merchantId?: string;
  environment?: string;
  devices?: StubDevice[];
}

/** The body of `GET /api/integrations/square`. */
export function squareIntegrationBody(state: SquareIntegrationState = {}) {
  const configured = state.configured ?? true;
  const status = state.status ?? "connected";
  return {
    configured,
    reason: configured ? null : (state.reason ?? "Square is not available on this deployment."),
    environment: configured ? (state.environment ?? "sandbox") : null,
    requestedScopes: ["PAYMENTS_WRITE", "DEVICE_CREDENTIAL_MANAGEMENT"],
    devices: configured && status === "connected" ? (state.devices ?? []) : [],
    connection: configured
      ? {
        status,
        merchantId: state.merchantId ?? "MLTESTMERCHANT",
        environment: state.environment ?? "sandbox",
        scopes: ["PAYMENTS_WRITE", "DEVICE_CREDENTIAL_MANAGEMENT"],
        connectedAt: new Date().toISOString(),
        refreshedAt: null,
        revokedAt: null,
        accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString()
      }
      : null
  };
}

type CheckoutStatus = "pending" | "in_progress" | "completed" | "canceled" | "failed" | "needs_review";

/** Mirrors `checkoutPresentation` — the only thing that decides what the capture modal renders. */
function presentation(status: CheckoutStatus, cancelReason: string | null, squareCheckoutId: string | null) {
  const reason = (cancelReason ?? "").toUpperCase();
  switch (status) {
    case "pending":
      return { label: squareCheckoutId ? "Waiting for the customer" : "Sending to the terminal", inFlight: true, settled: false, needsReview: false };
    case "in_progress":
      return { label: "In progress", inFlight: true, settled: false, needsReview: false };
    case "completed":
      return { label: "Completed", inFlight: false, settled: true, needsReview: false };
    case "canceled":
      if (reason === "TIMED_OUT" || reason === "TIMED_OUT_BEFORE_PAIRED") return { label: "Timed out", inFlight: false, settled: false, needsReview: false };
      if (reason === "DEVICE_OFFLINE") return { label: "Terminal offline", inFlight: false, settled: false, needsReview: false };
      return { label: "Cancelled", inFlight: false, settled: false, needsReview: false };
    case "failed":
      return { label: "Failed", inFlight: false, settled: false, needsReview: false };
    case "needs_review":
      return { label: "Needs review", inFlight: false, settled: false, needsReview: true };
    default:
      return { label: "Unknown", inFlight: false, settled: false, needsReview: true };
  }
}

export interface StubCheckout {
  id?: string;
  invoiceId: string;
  deviceId?: string;
  status?: CheckoutStatus;
  amountMinor?: number;
  cancelReason?: string | null;
  squareCheckoutId?: string | null;
  paidTotalMinor?: number | null;
  tipMinor?: number | null;
}

/** The body of the terminal-checkout endpoints, as `presentCheckout` builds it. */
export function terminalCheckoutBody(checkout: StubCheckout) {
  const status = checkout.status ?? "pending";
  const squareCheckoutId = checkout.squareCheckoutId ?? "sq-checkout-stub";
  return {
    id: checkout.id ?? "checkout-stub-0001",
    invoiceId: checkout.invoiceId,
    deviceId: checkout.deviceId ?? "device-stub-0001",
    status,
    amountMinor: checkout.amountMinor ?? 8500,
    currency: "USD",
    attempt: 1,
    cancelReason: checkout.cancelReason ?? null,
    lastError: null,
    mismatch: null,
    paymentId: status === "completed" ? "payment-stub-0001" : null,
    reconciledAt: status === "completed" ? new Date().toISOString() : null,
    paidTotalMinor: checkout.paidTotalMinor ?? null,
    tipMinor: checkout.tipMinor ?? null,
    ...presentation(status, checkout.cancelReason ?? null, squareCheckoutId)
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Serves `GET /api/integrations/square` from a state this test can mutate between clicks. */
export async function routeSquareIntegration(page: Page, read: () => SquareIntegrationState): Promise<void> {
  await page.route("**/api/integrations/square", (route) =>
    route.request().method() === "GET" ? json(route, squareIntegrationBody(read())) : route.continue());
}

/** Serves the checkout's narrow "which terminals may I use" read. */
export async function routeCheckoutTerminal(page: Page, devices: Array<{ id: string; label: string }>): Promise<void> {
  await page.route("**/api/checkout/terminal", (route) =>
    json(route, { available: devices.length > 0, devices }));
}

export { json as fulfillJson };
