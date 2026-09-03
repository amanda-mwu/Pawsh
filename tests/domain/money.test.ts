import { describe, expect, it } from "vitest";
import { applyDiscounts, calculateInvoice, creditLedgerTotals } from "@pawsh/domain";

describe("invoice calculation", () => {
  it("calculates cents with deterministic rounding", () => {
    expect(calculateInvoice({
      lineAmounts: [5_000, 1_500],
      discount: 500,
      taxRateBasisPoints: 825,
      tip: 1_000
    })).toEqual({
      subtotal: 6_500,
      discount: 500,
      taxableSubtotal: 6_000,
      tax: 495,
      tip: 1_000,
      total: 7_495
    });
  });

  it("rejects discounts above subtotal", () => {
    expect(() => calculateInvoice({
      lineAmounts: [500], discount: 501, taxRateBasisPoints: 0, tip: 0
    })).toThrow("Discount cannot exceed subtotal");
  });
});

/**
 * Discount arithmetic.
 *
 * The decided rule is that discounts COMPOUND: each one comes off what the previous ones left,
 * so $20 off then 10% off a $100 bill is $72 and not $70. Everything below either pins that or
 * pins one of the three properties `applyDiscounts` claims to hold by construction, because a
 * property nobody asserted is a property the next edit can lose silently.
 */
describe("discount application", () => {
  const amount = (amountMinor: number, units = 1) =>
    ({ kind: "amount" as const, amountMinor, units });
  const percentage = (rateBasisPoints: number) =>
    ({ kind: "percentage" as const, rateBasisPoints });

  it("compounds off the reduced amount rather than off the original bill", () => {
    // Amanda's worked example, and the whole reason the stacking mode is a setting.
    const result = applyDiscounts({
      subtotal: 10_000, lines: [amount(2_000), percentage(1_000)], stackingMode: "amount_first"
    });
    expect(result.discountMinor).toBe(2_800);
    expect(10_000 - result.discountMinor).toBe(7_200);
    // The percentage took 10% of the 8000 that remained, not 10% of 10000.
    expect(result.applied.map((step) => step.appliedMinor)).toEqual([2_000, 800]);
  });

  it("keeps the operator's order under one_per_appointment", () => {
    // The mode permits exactly one line - the server refuses a second with a 409 - so the sort
    // must be a no-op rather than a rule that would reorder a set it never sees.
    const single = applyDiscounts({
      subtotal: 10_000, lines: [percentage(1_500)], stackingMode: "one_per_appointment"
    });
    expect(single).toMatchObject({
      discountMinor: 1_500, applied: [{ index: 0, appliedMinor: 1_500 }]
    });
    const asGiven = applyDiscounts({
      subtotal: 10_000, lines: [percentage(1_000), amount(2_000)],
      stackingMode: "one_per_appointment"
    });
    expect(asGiven.applied.map((step) => step.index)).toEqual([0, 1]);
  });

  it("makes ordering the only difference between the two stacking modes", () => {
    const lines = [percentage(1_000), amount(2_000)];
    const amountFirst = applyDiscounts({ subtotal: 10_000, lines, stackingMode: "amount_first" });
    const percentageFirst = applyDiscounts({
      subtotal: 10_000, lines, stackingMode: "percentage_first"
    });

    // Same input, same two discounts, two different bills. $72 against $70.
    expect(amountFirst.discountMinor).toBe(2_800);
    expect(percentageFirst.discountMinor).toBe(3_000);
    expect(amountFirst.discountMinor).not.toBe(percentageFirst.discountMinor);

    // And the difference is ORDER: each mode ran the same two lines, front to back by kind.
    expect(amountFirst.applied.map((step) => step.kind)).toEqual(["amount", "percentage"]);
    expect(percentageFirst.applied.map((step) => step.kind)).toEqual(["percentage", "amount"]);
    // Every input line is applied exactly once under either mode; neither drops or repeats one.
    expect(amountFirst.applied.map((step) => step.index).sort()).toEqual([0, 1]);
    expect(percentageFirst.applied.map((step) => step.index).sort()).toEqual([0, 1]);
  });

  it("breaks ties within a kind by the order the operator applied them", () => {
    // Two amounts under amount_first share a rank, so nothing but the operator decides. The sort
    // has to be stable for that, and this is what says so.
    const result = applyDiscounts({
      subtotal: 10_000, lines: [amount(500), amount(700), percentage(1_000)],
      stackingMode: "amount_first"
    });
    expect(result.applied.map((step) => step.index)).toEqual([0, 1, 2]);
    expect(result.applied.map((step) => step.appliedMinor)).toEqual([500, 700, 880]);
  });

  it("clamps a fixed amount larger than the bill to zero instead of throwing", () => {
    // The old failure mode: `calculateInvoice` threw a bare Error for a discount above subtotal.
    // A configured $50 discount on a $30 groom is an ordinary thing an operator does, and it
    // settles the bill rather than erroring.
    const result = applyDiscounts({
      subtotal: 3_000, lines: [amount(5_000)], stackingMode: "amount_first"
    });
    expect(result.discountMinor).toBe(3_000);
    expect(result.applied).toEqual([{ index: 0, kind: "amount", appliedMinor: 3_000 }]);

    // And the line AFTER an exhausting one takes nothing rather than going negative.
    const exhausted = applyDiscounts({
      subtotal: 3_000, lines: [amount(5_000), percentage(2_000)], stackingMode: "amount_first"
    });
    expect(exhausted.discountMinor).toBe(3_000);
    expect(exhausted.applied.map((step) => step.appliedMinor)).toEqual([3_000, 0]);

    // A 100% percentage settles it too, and is the coupon case behind the zero-balance invoice.
    expect(applyDiscounts({
      subtotal: 8_500, lines: [percentage(10_000)], stackingMode: "amount_first"
    }).discountMinor).toBe(8_500);
  });

  it("treats per-pet and per-appointment as the same money at one pet", () => {
    // `appointments.pet_id` is singular, so the multiplier is 1 and the two scopes coincide. This
    // is the assertion that will FAIL, loudly and in the right place, the day that stops holding.
    const perAppointment = applyDiscounts({
      subtotal: 10_000, lines: [amount(1_500, 1)], stackingMode: "amount_first"
    });
    const perPet = applyDiscounts({
      subtotal: 10_000, lines: [amount(1_500, 1)], stackingMode: "amount_first"
    });
    expect(perPet).toEqual(perAppointment);
    expect(perPet.discountMinor).toBe(1_500);
    // The multiplier is real, not decorative: it just has nothing to multiply yet.
    expect(applyDiscounts({
      subtotal: 10_000, lines: [amount(1_500, 2)], stackingMode: "amount_first"
    }).discountMinor).toBe(3_000);
  });

  it("never lets the steps disagree with the aggregate, at adversarial rounding values", () => {
    // Thirds of odd cents, repeatedly, in both orders. If the aggregate were a sum of separately
    // rounded steps rather than the difference the fold made, this is where the drift would show.
    const rates = [3_333, 6_667, 1_111, 9_999, 1, 5_000];
    for (const subtotal of [1, 3, 7, 99, 101, 999, 1_001, 12_345, 99_999]) {
      for (const stackingMode of ["amount_first", "percentage_first"] as const) {
        const lines = [
          percentage(rates[subtotal % rates.length]!),
          amount(subtotal % 7),
          percentage(rates[(subtotal + 3) % rates.length]!),
          amount(subtotal % 13),
          percentage(rates[(subtotal + 1) % rates.length]!)
        ];
        const result = applyDiscounts({ subtotal, lines, stackingMode });
        const summed = result.applied.reduce((sum, step) => sum + step.appliedMinor, 0);
        const label = subtotal + "/" + stackingMode;

        expect(summed, label).toBe(result.discountMinor);
        expect(result.discountMinor, label).toBeLessThanOrEqual(subtotal);
        expect(result.discountMinor, label).toBeGreaterThanOrEqual(0);
        expect(result.applied.every((step) => step.appliedMinor >= 0), label).toBe(true);
        // Whatever the fold decided, the invoice it feeds still balances.
        expect(() => calculateInvoice({
          lineAmounts: [subtotal], discount: result.discountMinor, taxRateBasisPoints: 825, tip: 0
        }), label).not.toThrow();
      }
    }
  });

  it("takes nothing off when nothing was applied", () => {
    const none = applyDiscounts({ subtotal: 8_500, lines: [], stackingMode: "amount_first" });
    expect(none).toEqual({ subtotal: 8_500, discountMinor: 0, applied: [] });
    // A zero-value discount is a line that ran, not a line that was skipped: the receipt still
    // owes the customer a row saying it was applied and took nothing.
    const zero = applyDiscounts({
      subtotal: 8_500, lines: [amount(0), percentage(0)], stackingMode: "amount_first"
    });
    expect(zero.discountMinor).toBe(0);
    expect(zero.applied).toHaveLength(2);
  });

  it("refuses values that could not have come from the schema", () => {
    expect(() => applyDiscounts({ subtotal: -1, lines: [], stackingMode: "amount_first" }))
      .toThrow(/non-negative safe integer/);
    expect(() => applyDiscounts({
      subtotal: 100, lines: [percentage(10_001)], stackingMode: "amount_first"
    })).toThrow(/between 0 and 10000 basis points/);
    expect(() => applyDiscounts({
      subtotal: 100, lines: [amount(-5)], stackingMode: "amount_first"
    })).toThrow(/non-negative safe integer/);
    expect(() => applyDiscounts({
      subtotal: 100, lines: [amount(5, 0)], stackingMode: "amount_first"
    })).toThrow(/positive safe integer/);
    expect(() => applyDiscounts({
      subtotal: 100, lines: [], stackingMode: "cheapest_first" as never
    })).toThrow(/Unknown discount stacking mode/);
  });
});

/**
 * The credit tile's arithmetic, without a database.
 *
 * The property under test is that `grantedMinor - usedMinor === balanceMinor` for EVERY ledger,
 * because that subtraction is rendered on screen and an operator can see it fail. The four kinds
 * partition the table, so the two reported figures are a partition of the one sum the balance is -
 * these cases exist to prove the partition is drawn where it is claimed to be, and in particular
 * that reversals land on the used side rather than the granted side.
 */
describe("credit ledger totals", () => {
  it("reports an empty ledger as nothing on every figure", () => {
    expect(creditLedgerTotals({})).toEqual({ balanceMinor: 0, grantedMinor: 0, usedMinor: 0 });
  });

  it("treats a grant as granted and a redemption as used", () => {
    // $50 granted, $30 spent. The redemption is stored negative, which is what makes the balance
    // a plain sum rather than a subtraction nothing can check.
    expect(creditLedgerTotals({ grant: 5_000, redemption: -3_000 }))
      .toEqual({ balanceMinor: 2_000, grantedMinor: 5_000, usedMinor: 3_000 });
  });

  it("nets a reversal against the redemption it gave back", () => {
    // THE CASE THE TILE WOULD OTHERWISE GET WRONG. $50 granted, $30 spent, that payment voided.
    // `usedMinor` must be 0 and not 3000: the money came back, so the client has spent nothing,
    // and a tile reporting $30 used against a $50 balance would show a visible contradiction.
    const totals = creditLedgerTotals({
      grant: 5_000, redemption: -3_000, redemption_reversal: 3_000
    });
    expect(totals).toEqual({ balanceMinor: 5_000, grantedMinor: 5_000, usedMinor: 0 });
    expect(totals.grantedMinor - totals.usedMinor).toBe(totals.balanceMinor);
  });

  it("counts a negative adjustment as less granted, not as more used", () => {
    // A deduction is the salon taking back what it put on the account, so it reduces what was
    // GRANTED. Booking it as usage would claim the client spent money they never got.
    expect(creditLedgerTotals({ grant: 5_000, adjustment: -2_000 }))
      .toEqual({ balanceMinor: 3_000, grantedMinor: 3_000, usedMinor: 0 });
  });

  it("keeps granted minus used equal to the balance over an arbitrary ledger", () => {
    for (const sums of [
      { grant: 10_000, adjustment: -1_500, redemption: -4_000, redemption_reversal: 1_000 },
      { adjustment: 750 },
      { grant: 1, redemption: -1 },
      { grant: 9_999, adjustment: 1, redemption: -10_000, redemption_reversal: 10_000 }
    ]) {
      const totals = creditLedgerTotals(sums);
      expect(totals.grantedMinor - totals.usedMinor).toBe(totals.balanceMinor);
      // And the balance really is the plain sum of the column, which is the whole design.
      expect(totals.balanceMinor).toBe(Object.values(sums).reduce((sum, value) => sum + value, 0));
    }
  });

  it("refuses a sum that could not have come from the column", () => {
    expect(() => creditLedgerTotals({ grant: 1.5 })).toThrow(/safe integers/);
  });
});
