export interface InvoiceCalculation {
  subtotal: number;
  discount: number;
  taxableSubtotal: number;
  tax: number;
  tip: number;
  total: number;
}

export function calculateInvoice(input: {
  lineAmounts: readonly number[];
  discount: number;
  taxRateBasisPoints: number;
  tip: number;
}): InvoiceCalculation {
  const values = [...input.lineAmounts, input.discount, input.taxRateBasisPoints, input.tip];
  if (!values.every(Number.isSafeInteger) || input.lineAmounts.some((amount) => amount < 0)) {
    throw new Error("Money values must be non-negative safe integers");
  }
  if (input.discount < 0 || input.tip < 0 || input.taxRateBasisPoints < 0) {
    throw new Error("Discount, tip, and tax rate cannot be negative");
  }
  const subtotal = input.lineAmounts.reduce((sum, amount) => sum + amount, 0);
  if (input.discount > subtotal) throw new Error("Discount cannot exceed subtotal");
  const taxableSubtotal = subtotal - input.discount;
  const tax = Math.round((taxableSubtotal * input.taxRateBasisPoints) / 10_000);
  const total = taxableSubtotal + tax + input.tip;
  return { subtotal, discount: input.discount, taxableSubtotal, tax, tip: input.tip, total };
}
