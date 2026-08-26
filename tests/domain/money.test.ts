import { describe, expect, it } from "vitest";
import { calculateInvoice } from "@pawsh/domain";

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
