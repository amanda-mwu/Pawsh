import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  invoiceRefundedStatuses, invoiceStatusAfterSettlement, refundHeadroom, splitRefundAcrossTip
} from "../../src/domain/refunds.js";
import {
  mapSquareRefundStatus, paymentRefundIdempotencyKey, paymentRefundIdempotencyVersion,
  refundPresentation, squareRefundIdFromEvent
} from "../../src/integrations/square/refunds.js";
import {
  terminalCheckoutIdempotencyKey
} from "../../src/integrations/square/terminal.js";
import { invoiceStatuses } from "@pawsh/domain";

/**
 * The arithmetic of a refund, without a database and without a network.
 *
 * Everything here is a pure function on purpose, because every one of these is a rule somebody
 * would otherwise have to trust a comment about. The tip split in particular is a decision Pawsh
 * makes rather than one Square reports - Square sends one amount and never says how much of it was
 * gratuity - so nothing outside this file can check it. If it is wrong, a groomer loses money and
 * no error is ever raised.
 *
 * NOTHING HERE IS SANDBOX-VERIFIED. No Square credentials exist for this project.
 */

describe("the tip is refunded last", () => {
  // A $65 groom with a $10 tip the customer added on the terminal: the payment row is $75, and
  // its `provider_tip_minor` is $10.
  const payment = { paymentAmountMinor: 7_500, paymentTipMinor: 1_000 };

  it("returns the whole tip on a full refund, and only on a full refund", () => {
    expect(splitRefundAcrossTip({
      ...payment, alreadyRefundedMinor: 0, refundAmountMinor: 7_500
    })).toEqual({ serviceMinor: 6_500, tipMinor: 1_000 });
  });

  it("takes nothing from the tip while service money is left", () => {
    // The customer disputes half the groom. The groomer keeps every cent of the gratuity, because
    // the complaint was about the service and there is service money left to give back.
    expect(splitRefundAcrossTip({
      ...payment, alreadyRefundedMinor: 0, refundAmountMinor: 3_000
    })).toEqual({ serviceMinor: 3_000, tipMinor: 0 });
  });

  it("takes nothing from the tip when the refund lands exactly on the service amount", () => {
    // The boundary case, and the one a proportional split would get wrong by $10: the entire
    // disputed service is returned and the gratuity is untouched.
    expect(splitRefundAcrossTip({
      ...payment, alreadyRefundedMinor: 0, refundAmountMinor: 6_500
    })).toEqual({ serviceMinor: 6_500, tipMinor: 0 });
  });

  it("reaches into the tip only once the service amount is exhausted", () => {
    expect(splitRefundAcrossTip({
      ...payment, alreadyRefundedMinor: 0, refundAmountMinor: 7_000
    })).toEqual({ serviceMinor: 6_500, tipMinor: 500 });
  });

  it("computes the split against the running position, not against the payment", () => {
    // Two refunds that together consume the service amount must consume it exactly once. Reading
    // each refund in isolation would return $60 of service twice and never reach the tip at all.
    const first = splitRefundAcrossTip({
      ...payment, alreadyRefundedMinor: 0, refundAmountMinor: 6_000
    });
    expect(first).toEqual({ serviceMinor: 6_000, tipMinor: 0 });
    const second = splitRefundAcrossTip({
      ...payment, alreadyRefundedMinor: 6_000, refundAmountMinor: 1_500
    });
    expect(second).toEqual({ serviceMinor: 500, tipMinor: 1_000 });
    expect(first.serviceMinor + second.serviceMinor).toBe(6_500);
    expect(first.tipMinor + second.tipMinor).toBe(1_000);
  });

  it("puts everything in the service portion when there was no tip", () => {
    expect(splitRefundAcrossTip({
      paymentAmountMinor: 4_000, paymentTipMinor: 0,
      alreadyRefundedMinor: 0, refundAmountMinor: 4_000
    })).toEqual({ serviceMinor: 4_000, tipMinor: 0 });
  });

  it("puts everything in the tip once the service amount is already gone", () => {
    expect(splitRefundAcrossTip({
      ...payment, alreadyRefundedMinor: 6_500, refundAmountMinor: 1_000
    })).toEqual({ serviceMinor: 0, tipMinor: 1_000 });
  });
});

describe("refund headroom", () => {
  it("counts completed refunds against the payment", () => {
    expect(refundHeadroom({
      paymentAmountMinor: 7_500,
      refunds: [{ amountMinor: 2_500, status: "completed" }]
    })).toEqual({ committedMinor: 2_500, remainingMinor: 5_000, exhausted: false });
  });

  it("counts PENDING refunds too, so a retry cannot over-refund", () => {
    // The whole reason pending counts: the money has not moved, but it is spoken for. A second
    // request that ignored it would ask Square for the same money twice, and Square would agree.
    expect(refundHeadroom({
      paymentAmountMinor: 7_500,
      refunds: [
        { amountMinor: 2_500, status: "completed" },
        { amountMinor: 5_000, status: "pending" }
      ]
    })).toEqual({ committedMinor: 7_500, remainingMinor: 0, exhausted: true });
  });

  it("releases the headroom a failed refund was holding", () => {
    expect(refundHeadroom({
      paymentAmountMinor: 7_500,
      refunds: [
        { amountMinor: 5_000, status: "failed" },
        { amountMinor: 2_500, status: "completed" }
      ]
    })).toEqual({ committedMinor: 2_500, remainingMinor: 5_000, exhausted: false });
  });

  // The state a mismatched refund rests in. It must hold its headroom for a STRONGER reason than
  // `pending` does: what Square did with the money is exactly what nobody knows, so releasing it
  // would invite a second refund on top of one that may already have gone through.
  it("keeps holding the headroom of a refund that needs review", () => {
    expect(refundHeadroom({
      paymentAmountMinor: 7_500,
      refunds: [{ amountMinor: 7_500, status: "needs_review" }]
    })).toEqual({ committedMinor: 7_500, remainingMinor: 0, exhausted: true });
  });

  it("never reports negative headroom", () => {
    expect(refundHeadroom({
      paymentAmountMinor: 1_000,
      refunds: [{ amountMinor: 1_500, status: "completed" }]
    }).remainingMinor).toBe(0);
  });
});

describe("the invoice status a settlement implies", () => {
  it("is paid when nothing went back", () => {
    expect(invoiceStatusAfterSettlement({
      totalMinor: 7_500, balanceMinor: 0, paidMinor: 7_500, refundedMinor: 0
    })).toBe("paid");
  });

  it("is partially_refunded when some of it went back", () => {
    expect(invoiceStatusAfterSettlement({
      totalMinor: 7_500, balanceMinor: 0, paidMinor: 7_500, refundedMinor: 2_500
    })).toBe("partially_refunded");
  });

  it("is refunded when all of it went back", () => {
    expect(invoiceStatusAfterSettlement({
      totalMinor: 7_500, balanceMinor: 0, paidMinor: 7_500, refundedMinor: 7_500
    })).toBe("refunded");
  });

  it("stays outstanding while money is owed, refund or no refund", () => {
    // The refunded statuses replace `paid` and ONLY `paid`. An invoice that still owes money is
    // collectable, and labelling it "Partly refunded" would take it out of every outstanding list
    // in the product while somebody still had to chase it.
    expect(invoiceStatusAfterSettlement({
      totalMinor: 10_000, balanceMinor: 4_000, paidMinor: 6_000, refundedMinor: 2_000
    })).toBe("partially_paid");
    expect(invoiceStatusAfterSettlement({
      totalMinor: 10_000, balanceMinor: 10_000, paidMinor: 0, refundedMinor: 0
    })).toBe("open");
  });

  it("calls a zero-total invoice paid rather than open", () => {
    // A free visit is created `paid` with no payment rows at all. Reading "balance >= total"
    // first would file it as open and put a zero-balance invoice on the outstanding list.
    expect(invoiceStatusAfterSettlement({
      totalMinor: 0, balanceMinor: 0, paidMinor: 0, refundedMinor: 0
    })).toBe("paid");
  });

  it("only ever returns a status the enum actually has", () => {
    for (const scenario of [
      { totalMinor: 0, balanceMinor: 0, paidMinor: 0, refundedMinor: 0 },
      { totalMinor: 100, balanceMinor: 100, paidMinor: 0, refundedMinor: 0 },
      { totalMinor: 100, balanceMinor: 40, paidMinor: 60, refundedMinor: 0 },
      { totalMinor: 100, balanceMinor: 0, paidMinor: 100, refundedMinor: 0 },
      { totalMinor: 100, balanceMinor: 0, paidMinor: 100, refundedMinor: 40 },
      { totalMinor: 100, balanceMinor: 0, paidMinor: 100, refundedMinor: 100 }
    ]) {
      expect(invoiceStatuses).toContain(invoiceStatusAfterSettlement(scenario));
    }
  });

  it("names the refunded statuses without including any outstanding one", () => {
    expect([...invoiceRefundedStatuses]).toEqual(["partially_refunded", "refunded"]);
    expect(invoiceRefundedStatuses).not.toContain("open");
    expect(invoiceRefundedStatuses).not.toContain("partially_paid");
  });
});

describe("the refund idempotency key", () => {
  const facts = {
    businessId: "5c0b5d5c-3c0f-4a54-9d6a-6a5f3a6f7c11",
    paymentId: "7f2a1c0e-9b21-4a3c-8d90-1e2f3a4b5c6d",
    amountMinor: 7_500,
    attempt: 1
  };

  it("is deterministic, so a retry reproduces it exactly", () => {
    expect(paymentRefundIdempotencyKey(facts)).toBe(paymentRefundIdempotencyKey({ ...facts }));
  });

  it("re-derives from the values a row stores", () => {
    // The row carries `business_id`, `payment_id`, `amount_minor` and `attempt`, so the key can be
    // recomputed from disk and checked rather than merely trusted. This is that check.
    const row = {
      businessId: facts.businessId, paymentId: facts.paymentId,
      amountMinor: facts.amountMinor, attempt: facts.attempt,
      idempotencyKey: paymentRefundIdempotencyKey(facts)
    };
    expect(paymentRefundIdempotencyKey({
      businessId: row.businessId, paymentId: row.paymentId,
      amountMinor: row.amountMinor, attempt: row.attempt
    })).toBe(row.idempotencyKey);
  });

  it("is a different key for a different attempt, amount, payment or business", () => {
    const base = paymentRefundIdempotencyKey(facts);
    expect(paymentRefundIdempotencyKey({ ...facts, attempt: 2 })).not.toBe(base);
    expect(paymentRefundIdempotencyKey({ ...facts, amountMinor: 7_499 })).not.toBe(base);
    expect(paymentRefundIdempotencyKey({
      ...facts, paymentId: "00000000-0000-4000-8000-000000000000"
    })).not.toBe(base);
    expect(paymentRefundIdempotencyKey({
      ...facts, businessId: "00000000-0000-4000-8000-000000000000"
    })).not.toBe(base);
  });

  it("fits inside Square's 45-character limit for the Refunds API", () => {
    // Terminal allows 64 and this one does not. A key that overflowed would be rejected at the
    // moment a customer is waiting for their money back.
    expect(paymentRefundIdempotencyKey(facts)).toHaveLength(43);
    expect(paymentRefundIdempotencyKey(facts)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is not the terminal key, even when every shared input matches", () => {
    // Two derivations that could collide would let a refund and a checkout be treated as the same
    // request by Square. The version string leading each hash is what prevents it.
    const terminal = terminalCheckoutIdempotencyKey({
      businessId: facts.businessId, invoiceId: facts.paymentId,
      deviceId: facts.paymentId, amountMinor: facts.amountMinor, currency: "USD", attempt: 1
    });
    expect(paymentRefundIdempotencyKey(facts)).not.toBe(terminal);
  });

  it("hashes exactly the canonical array it documents", () => {
    expect(paymentRefundIdempotencyKey(facts)).toBe(
      createHash("sha256").update(JSON.stringify([
        paymentRefundIdempotencyVersion, facts.businessId, facts.paymentId,
        facts.amountMinor, facts.attempt
      ]), "utf8").digest("base64url")
    );
  });
});

describe("Square's refund status, mapped", () => {
  it("treats COMPLETED as the only value that means money went back", () => {
    expect(mapSquareRefundStatus("COMPLETED")).toEqual({
      status: "completed", recognised: true, failureReason: null
    });
  });

  it("treats PENDING as in flight", () => {
    expect(mapSquareRefundStatus("PENDING").status).toBe("pending");
  });

  it("treats REJECTED and FAILED as terminal, each with a sentence", () => {
    for (const status of ["REJECTED", "FAILED"]) {
      const mapped = mapSquareRefundStatus(status);
      expect(mapped.status).toBe("failed");
      expect(mapped.recognised).toBe(true);
      expect(mapped.failureReason).toBeTruthy();
    }
  });

  it("resolves an unrecognised status explicitly, and never to success", () => {
    // The branch that matters most and is hardest to reach in production. Guessing `completed`
    // would show a refund as done that may never happen; guessing `failed` would release the
    // headroom for money Square may still be moving, which is how one refund becomes two. Staying
    // in flight is the only answer that cannot create money, and `recognised: false` says out loud
    // that this is a fallback rather than a reading of Square's vocabulary.
    for (const status of ["SOMETHING_NEW", "", undefined, "completed "]) {
      const mapped = mapSquareRefundStatus(status);
      expect(mapped.status).toBe("pending");
      expect(mapped.recognised).toBe(false);
      expect(mapped.failureReason).toBeNull();
    }
  });

  it("is case-insensitive about Square's own vocabulary", () => {
    expect(mapSquareRefundStatus("completed").status).toBe("completed");
  });
});

describe("what a screen is allowed to say", () => {
  it("says refunded only for a completed row", () => {
    expect(refundPresentation({ status: "completed", providerRefundId: "R1" })).toEqual({
      label: "Refunded", inFlight: false, settled: true, failed: false, needsReview: false
    });
  });

  it("never reports a pending refund as settled", () => {
    expect(refundPresentation({ status: "pending", providerRefundId: "R1" }).settled).toBe(false);
    expect(refundPresentation({ status: "pending", providerRefundId: null }).settled).toBe(false);
    // Two different sentences, because "we have not sent this yet" and "the processor has not
    // finished" are different things to be told while a customer is standing there.
    expect(refundPresentation({ status: "pending", providerRefundId: null }).label)
      .toBe("Sending the refund");
    expect(refundPresentation({ status: "pending", providerRefundId: "R1" }).label)
      .toBe("Refund in progress");
  });

  it("never reports a failed refund as settled", () => {
    expect(refundPresentation({ status: "failed", providerRefundId: null })).toEqual({
      label: "Refund failed", inFlight: false, settled: false, failed: true, needsReview: false
    });
  });

  // The state a refund rests in when Square reported something Pawsh did not ask for. It is
  // emphatically not `failed`: telling an operator "the refund failed" asserts the customer still
  // has their money, and that is the one thing this state cannot promise.
  it("says a mismatched refund needs review without calling it failed or settled", () => {
    expect(refundPresentation({ status: "needs_review", providerRefundId: "R1" })).toEqual({
      label: "Refund needs review", inFlight: false, settled: false, failed: false,
      needsReview: true
    });
  });

  it("refuses to call an unknown state settled", () => {
    expect(refundPresentation({
      status: "something-else" as never, providerRefundId: null
    }).settled).toBe(false);
    // And routes it to a person rather than letting it look like an ordinary in-flight refund.
    expect(refundPresentation({
      status: "something-else" as never, providerRefundId: null
    }).needsReview).toBe(true);
  });
});

describe("resolving a refund.updated event", () => {
  it("finds the refund id Square names", () => {
    expect(squareRefundIdFromEvent({
      data: { object: { refund: { id: "PAY_RFND1" } } }
    })).toBe("PAY_RFND1");
  });

  it("returns nothing for a body that names no refund", () => {
    for (const payload of [
      null, {}, { data: {} }, { data: { object: {} } },
      { data: { object: { refund: {} } } },
      { data: { object: { refund: { id: "" } } } },
      { data: { object: { refund: { id: 7 } } } },
      { data: { object: { payment: { id: "PAY" } } } }
    ]) {
      expect(squareRefundIdFromEvent(payload)).toBeUndefined();
    }
  });
});
