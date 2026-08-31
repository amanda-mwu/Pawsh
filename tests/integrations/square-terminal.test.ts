import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createSquareClient, type SquareFetch } from "../../src/integrations/square/client.js";
import type { SquarePayment } from "../../src/integrations/square/schemas.js";
import {
  checkoutPresentation, devicePairingView, mapSquareCheckoutStatus,
  terminalCheckoutIdempotencyKey, terminalCheckoutIdempotencyVersion
} from "../../src/integrations/square/terminal.js";
import { decideReconciliation } from "../../src/integrations/square/reconciliation.js";

/**
 * The parts of Terminal capture that must be provable without a database and without a network.
 *
 * Two things are being defended here. The idempotency key is the one property a customer feels
 * when it is wrong, and "deterministic" is only a claim until something derives it twice from the
 * same facts and compares. And the reconciliation decision is where money either posts or does
 * not; every refusal in it has to be reachable from a test, because a branch that only fires
 * against live Square is a branch nobody has ever seen run.
 */

async function fixture(name: string): Promise<string> {
  return readFile(`tests/fixtures/square/${name}`, "utf8");
}

function transport(responses: { body: string; status?: number }[]): {
  fetchImplementation: SquareFetch; calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  return {
    calls,
    fetchImplementation: async (url, init) => {
      calls.push({ url, init });
      const next = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return new Response(next.body, {
        status: next.status ?? 200, headers: { "content-type": "application/json" }
      });
    }
  };
}

function client(responses: { body: string; status?: number }[]) {
  const injected = transport(responses);
  return {
    calls: injected.calls,
    square: createSquareClient({
      environment: "sandbox",
      applicationId: "sandbox-sq0idb-TEST-APPLICATION",
      applicationSecret: "sandbox-sq0csb-TEST-SECRET",
      fetchImplementation: injected.fetchImplementation
    })
  };
}

const attempt = {
  businessId: "9f2f4d64-2f0d-4b8c-9a44-6a4f9c1a1f11",
  invoiceId: "6a1f0f0e-0f5a-4a1e-9f2b-1c2d3e4f5a6b",
  deviceId: "1c9d4f2a-8e3b-4d55-9a01-2b3c4d5e6f70",
  amountMinor: 6500,
  currency: "USD",
  attempt: 1
};

describe("Terminal checkout idempotency key", () => {
  it("is a pure function of the attempt, with no clock and no randomness in it", () => {
    const first = terminalCheckoutIdempotencyKey(attempt);
    const second = terminalCheckoutIdempotencyKey({ ...attempt });
    expect(first).toBe(second);
    // Derived twice, milliseconds apart, from a copy of the same facts. If a timestamp or a
    // random value ever creeps into the derivation, this is what fails.
    expect(terminalCheckoutIdempotencyKey(attempt)).toBe(first);
  });

  it("fits inside Square's 45-character limit with the full hash in it", () => {
    const key = terminalCheckoutIdempotencyKey(attempt);
    // 32 bytes of SHA-256, base64url, is exactly 43 characters and no padding.
    expect(key).toHaveLength(43);
    expect(key.length).toBeLessThanOrEqual(45);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("changes when any fact about the attempt changes", () => {
    const base = terminalCheckoutIdempotencyKey(attempt);
    const variants = [
      { ...attempt, businessId: "00000000-0000-4000-8000-000000000001" },
      { ...attempt, invoiceId: "00000000-0000-4000-8000-000000000002" },
      { ...attempt, deviceId: "00000000-0000-4000-8000-000000000003" },
      { ...attempt, amountMinor: 6501 },
      { ...attempt, currency: "CAD" },
      { ...attempt, attempt: 2 }
    ];
    const keys = new Set(variants.map(terminalCheckoutIdempotencyKey));
    expect(keys.size).toBe(variants.length);
    expect(keys.has(base)).toBe(false);
  });

  it("is versioned, so a future derivation cannot be mistaken for this one", () => {
    // Pinned deliberately: changing the recipe must change the key for every attempt, which is a
    // new request to Square rather than a silently reinterpreted old one.
    expect(terminalCheckoutIdempotencyVersion).toBe("pawsh.square.terminal-checkout.v1");
    expect(terminalCheckoutIdempotencyKey(attempt))
      .toBe("Z3ngnBpLjsOBzwq9L2RCHWbXp90l-h3f9OESULQrIes");
  });
});

describe("Square checkout status mapping", () => {
  it("never turns Square's COMPLETED into ours", () => {
    // Square's COMPLETED means the terminal finished. Ours means a Payment has been posted to the
    // ledger. Collapsing the two is how a screen says "paid" before any money is confirmed.
    const completed = mapSquareCheckoutStatus("COMPLETED");
    expect(completed.status).toBe("in_progress");
    expect(completed.settledAtSquare).toBe(true);
  });

  it("treats a status it does not recognise as still in flight", () => {
    for (const unknown of ["SOMETHING_NEW", "", undefined]) {
      const mapped = mapSquareCheckoutStatus(unknown);
      // Guessing "canceled" would tell a salon to take the money another way while a terminal is
      // still holding the customer's card.
      expect(mapped.status).toBe("in_progress");
      expect(mapped.settledAtSquare).toBe(false);
    }
  });

  it("maps the states the terminal actually moves through", () => {
    expect(mapSquareCheckoutStatus("PENDING").status).toBe("pending");
    expect(mapSquareCheckoutStatus("IN_PROGRESS").status).toBe("in_progress");
    expect(mapSquareCheckoutStatus("CANCEL_REQUESTED").status).toBe("in_progress");
    expect(mapSquareCheckoutStatus("CANCELED").status).toBe("canceled");
  });
});

describe("What the operator is told", () => {
  it("says paid for exactly one status, and that one is only written by the reconciler", () => {
    const settled = ["pending", "in_progress", "canceled", "failed", "needs_review", "completed"]
      .filter((status) => checkoutPresentation({
        status: status as never, cancelReason: null, squareCheckoutId: "CHK"
      }).settled);
    expect(settled).toEqual(["completed"]);
  });

  it("tells a timed-out terminal apart from somebody's decision", () => {
    const reasons: [string | null, string][] = [
      ["TIMED_OUT", "Timed out"],
      ["DEVICE_OFFLINE", "Terminal offline"],
      ["CANCELED_BY_CUSTOMER", "Cancelled"],
      ["CANCELED_BY_SELLER", "Cancelled"],
      [null, "Cancelled"]
    ];
    for (const [reason, label] of reasons) {
      expect(checkoutPresentation({
        status: "canceled", cancelReason: reason, squareCheckoutId: "CHK"
      }).label, reason ?? "no reason").toBe(label);
    }
  });

  it("distinguishes a checkout that has not reached the terminal from one waiting on a customer", () => {
    expect(checkoutPresentation({ status: "pending", cancelReason: null, squareCheckoutId: null }).label)
      .toBe("Sending to the terminal");
    expect(checkoutPresentation({ status: "pending", cancelReason: null, squareCheckoutId: "CHK" }).label)
      .toBe("Waiting for the customer");
  });
});

describe("Device pairing as a screen sees it", () => {
  const now = new Date("2026-08-31T09:30:00Z");

  it("reports a code past its pair_by as expired, before any sweep has run", () => {
    const view = devicePairingView({
      pairingStatus: "unpaired", deviceCodeId: "DC1", deviceCode: "PAWSH1",
      pairBy: new Date("2026-08-31T09:29:59Z")
    }, now);
    expect(view.status).toBe("expired");
    // The code is withheld once it stops working. Showing a dead code beside "waiting to pair"
    // sends a salon to type it into a terminal over and over.
    expect(view.code).toBeNull();
  });

  it("shows the code while it can still be typed in", () => {
    const view = devicePairingView({
      pairingStatus: "unpaired", deviceCodeId: "DC1", deviceCode: "PAWSH1",
      pairBy: new Date("2026-08-31T09:31:00Z")
    }, now);
    expect(view).toEqual({ status: "unpaired", code: "PAWSH1", pairBy: new Date("2026-08-31T09:31:00Z") });
  });

  it("treats a device that has never been given a code as expired rather than waiting", () => {
    const view = devicePairingView({
      pairingStatus: "unpaired", deviceCodeId: null, deviceCode: null, pairBy: null
    }, now);
    expect(view.status).toBe("expired");
  });

  it("never leaks a code for a paired device", () => {
    expect(devicePairingView({
      pairingStatus: "paired", deviceCodeId: "DC1", deviceCode: "PAWSH1", pairBy: null
    }, now)).toEqual({ status: "paired", code: null, pairBy: null });
  });
});

describe("The reconciliation decision", () => {
  const invoice = { status: "open", balanceMinor: 6500, tipMinor: 0, totalMinor: 6500 };
  function payment(overrides: Partial<SquarePayment> = {}): SquarePayment {
    return {
      id: "PAYSAMPLE00000001",
      status: "COMPLETED",
      amount_money: { amount: 6500, currency: "USD" },
      tip_money: { amount: 1000, currency: "USD" },
      total_money: { amount: 7500, currency: "USD" },
      ...overrides
    };
  }
  function decide(input: {
    checkout?: { status?: string; cancel_reason?: string; payment_ids?: string[] };
    payments?: SquarePayment[];
    invoice?: typeof invoice;
    businessCurrency?: string;
  } = {}) {
    return decideReconciliation({
      checkoutAmountMinor: 6500,
      checkoutCurrency: "USD",
      businessCurrency: input.businessCurrency ?? "USD",
      invoice: input.invoice ?? invoice,
      checkout: input.checkout ?? { status: "COMPLETED", payment_ids: ["PAYSAMPLE00000001"] },
      payments: input.payments ?? [payment()]
    });
  }

  it("posts Square's total, with the tip recorded beside it", () => {
    expect(decide()).toEqual({
      outcome: "post", providerPaymentId: "PAYSAMPLE00000001",
      amountMinor: 6500, tipMinor: 1000, totalMinor: 7500
    });
  });

  it("treats a missing tip object as no tip rather than as a missing field", () => {
    const decision = decide({ payments: [payment({ tip_money: undefined, total_money: undefined })] });
    expect(decision).toMatchObject({ outcome: "post", tipMinor: 0, totalMinor: 6500 });
  });

  it("lets the payment win over a checkout Square calls cancelled", () => {
    // The card was charged. Whatever the checkout says, the money moved.
    expect(decide({
      checkout: { status: "CANCELED", cancel_reason: "CANCELED_BY_SELLER", payment_ids: ["PAYSAMPLE00000001"] }
    })).toMatchObject({ outcome: "post" });
  });

  it("stays in flight while the terminal is still working", () => {
    expect(decide({ checkout: { status: "PENDING", payment_ids: [] }, payments: [] }))
      .toEqual({ outcome: "in_flight", status: "pending" });
    expect(decide({ checkout: { status: "IN_PROGRESS", payment_ids: [] }, payments: [] }))
      .toEqual({ outcome: "in_flight", status: "in_progress" });
  });

  it("records a cancellation with Square's own reason", () => {
    expect(decide({
      checkout: { status: "CANCELED", cancel_reason: "TIMED_OUT", payment_ids: [] }, payments: []
    })).toEqual({ outcome: "canceled", cancelReason: "TIMED_OUT" });
  });

  it("fails rather than posts when no payment completed", () => {
    const decision = decide({
      payments: [payment({ status: "FAILED" })]
    });
    expect(decision.outcome).toBe("failed");
    expect((decision as { reason: string }).reason).toContain("FAILED");
  });

  it("refuses to guess when Square reports a completed checkout with no payment", () => {
    const decision = decide({ checkout: { status: "COMPLETED", payment_ids: [] }, payments: [] });
    expect(decision).toMatchObject({
      outcome: "needs_review", mismatch: { reason: "completed_without_payment" }
    });
  });

  it("refuses to choose between two completed payments", () => {
    const decision = decide({
      payments: [payment(), payment({ id: "PAYSAMPLE00000002", amount_money: { amount: 6500, currency: "USD" } })]
    });
    expect(decision).toMatchObject({ outcome: "needs_review", mismatch: { reason: "multiple_payments" } });
  });

  it("never posts a payment in a currency the invoice is not written in", () => {
    const decision = decide({
      payments: [payment({
        amount_money: { amount: 6500, currency: "CAD" },
        tip_money: { amount: 1000, currency: "CAD" },
        total_money: { amount: 7500, currency: "CAD" }
      })]
    });
    expect(decision).toMatchObject({ outcome: "needs_review", mismatch: { reason: "currency" } });
  });

  it("refuses an amount that is not the amount it asked for, in either direction", () => {
    for (const amount of [6400, 6600]) {
      const decision = decide({
        payments: [payment({
          amount_money: { amount, currency: "USD" },
          total_money: { amount: amount + 1000, currency: "USD" }
        })]
      });
      // There is no auto-coercion path: no adjustment, no partial post, no rounding.
      expect(decision, String(amount)).toMatchObject({
        outcome: "needs_review", mismatch: { reason: "amount", expected: 6500, received: amount }
      });
    }
  });

  it("refuses a payment whose own total does not add up", () => {
    const decision = decide({
      payments: [payment({ total_money: { amount: 9999, currency: "USD" } })]
    });
    expect(decision).toMatchObject({
      outcome: "needs_review", mismatch: { reason: "total_arithmetic" }
    });
  });

  it("refuses when the invoice moved while the card was in the reader", () => {
    expect(decide({ invoice: { ...invoice, balanceMinor: 6000 } })).toMatchObject({
      outcome: "needs_review", mismatch: { reason: "invoice_balance" }
    });
    expect(decide({ invoice: { ...invoice, status: "paid" } })).toMatchObject({
      outcome: "needs_review", mismatch: { reason: "invoice_status" }
    });
  });

  it("refuses to raise a tip on an invoice that already carries one", () => {
    // The raise is only sound on an invoice created with `tipMinor: 0`. Anything else was
    // captured another way, and adding to it would invent money.
    expect(decide({ invoice: { ...invoice, tipMinor: 300 } })).toMatchObject({
      outcome: "needs_review", mismatch: { reason: "invoice_tip", expected: 0, received: 300 }
    });
  });

  it("still posts a zero-tip payment onto an invoice that carries a tip from elsewhere", () => {
    // Only the raise is fenced. A payment with no tip changes no invoice component, so there is
    // nothing unsound about it.
    expect(decide({
      invoice: { ...invoice, tipMinor: 300, balanceMinor: 6500 },
      payments: [payment({ tip_money: undefined, total_money: undefined })]
    })).toMatchObject({ outcome: "post", tipMinor: 0 });
  });
});

describe("The Terminal endpoints", () => {
  it("pins TERMINAL_API and passes the idempotency key through untouched", async () => {
    const { square, calls } = client([{ body: await fixture("device-code.json") }]);
    const code = await square.createDeviceCode({
      accessToken: "token", idempotencyKey: "idem-1",
      squareLocationId: "LSAMPLE000000001", name: "Front Counter Terminal"
    });
    expect(calls[0]!.url).toBe("https://connect.squareupsandbox.com/v2/devices/codes");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.idempotency_key).toBe("idem-1");
    // Wrong product type pairs successfully and then refuses every checkout, at a counter, with a
    // customer waiting. It is pinned in code rather than passed in.
    expect(body.device_code.product_type).toBe("TERMINAL_API");
    expect(body.device_code.location_id).toBe("LSAMPLE000000001");
    // `pair_by` is read, never assumed.
    expect(code.pair_by).toBe("2026-08-31T09:25:11Z");
  });

  it("sends the amount and the salon's tip presets, and nothing a client chose", async () => {
    const { square, calls } = client([{ body: await fixture("terminal-checkout.json") }]);
    await square.createTerminalCheckout({
      accessToken: "token",
      idempotencyKey: "Z3ngnBpLjsOBzwq9L2RCHWbXp90l-h3f9OESULQrIes",
      deviceId: "DEVICESAMPLE0001",
      amountMinor: 6500,
      currency: "USD",
      referenceId: "6a1f0f0e-0f5a-4a1e-9f2b-1c2d3e4f5a6b",
      tipPercentages: [15, 18, 20]
    });
    expect(calls[0]!.url).toBe("https://connect.squareupsandbox.com/v2/terminals/checkouts");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.idempotency_key).toBe("Z3ngnBpLjsOBzwq9L2RCHWbXp90l-h3f9OESULQrIes");
    expect(body.checkout.amount_money).toEqual({ amount: 6500, currency: "USD" });
    expect(body.checkout.device_options.device_id).toBe("DEVICESAMPLE0001");
    expect(body.checkout.reference_id).toHaveLength(36);
    expect(body.checkout.tip_settings.tip_percentages).toEqual([15, 18, 20]);
    expect(body.checkout.tip_settings.allow_tipping).toBe(true);
  });

  it("reads a cancellation reason back rather than flattening it to cancelled", async () => {
    const { square } = client([{ body: await fixture("terminal-checkout-canceled.json") }]);
    const checkout = await square.retrieveTerminalCheckout({
      accessToken: "token", checkoutId: "CHKSAMPLE00000002"
    });
    expect(checkout.status).toBe("CANCELED");
    expect(checkout.cancel_reason).toBe("TIMED_OUT");
  });

  it("reads a payment's amount, tip and total as three separate facts", async () => {
    const { square, calls } = client([{ body: await fixture("payment.json") }]);
    const payment = await square.retrievePayment({
      accessToken: "token", paymentId: "PAYSAMPLE00000001"
    });
    expect(calls[0]!.url).toBe("https://connect.squareupsandbox.com/v2/payments/PAYSAMPLE00000001");
    expect(payment.amount_money.amount).toBe(6500);
    expect(payment.tip_money?.amount).toBe(1000);
    expect(payment.total_money?.amount).toBe(7500);
    expect(payment.terminal_checkout_id).toBe("CHKSAMPLE00000001");
  });

  it("refuses a checkout response whose shape it does not recognise", async () => {
    const { square } = client([{ body: JSON.stringify({ checkout: { id: "CHK" } }) }]);
    // No `amount_money`. A 200 we cannot read is not a success, and returning it would push the
    // surprise into the reconciler.
    await expect(square.retrieveTerminalCheckout({ accessToken: "t", checkoutId: "CHK" }))
      .rejects.toMatchObject({ code: "malformed_response" });
  });
});
