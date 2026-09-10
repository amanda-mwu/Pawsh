import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE INVOICE'S MONEY STATEMENT READS AS GROUPED SECTIONS, NOT AS A LEDGER OF EQUAL ROWS.
 *
 * The defect this file exists for, in the owner's words: the financial breakdown was "too flat and
 * difficult to scan". Every line was one bare `<div>` carrying the same rule above it and the same
 * weight as the line beside it, so
 *
 *     Full Groom $85.00 / Subtotal $85.00 / Senior pet discount -$10.00 / Welcome 15% -$11.25 /
 *     Total discount -$21.25 / Tax $5.26 / Tip $10.00 / Total $79.01 / Balance $79.01
 *
 * arrived as one undifferentiated column, and finding what the visit came to meant reading all of
 * it. `Subtotal $85.00` sat directly above `Total $79.01`; on a bill with no discount, no tax and
 * no tip the two were the same figure under two names.
 *
 * THE RULES THIS FILE HOLDS, each of them the owner's:
 *
 *   - no generic `Subtotal` immediately followed by a `Total` communicating the same thing
 *   - `Service subtotal` only where it explains a downstream discount, tax or tip
 *   - EXACTLY ONE clearly emphasised final financial total, and it is called `Invoice total`
 *   - `Balance` stays separate; it is what is currently owed, not what the visit came to
 *   - payment records stay visually separate from the calculation rows
 *   - discount names and amounts are preserved, and a voided payment stays visible
 *   - rows do not all carry the same visual weight
 *
 * AND THE ONE RULE THAT IS NOT ABOUT READABILITY: NO FIGURE MOVED. This is presentation. Every
 * assertion below states a figure as well as a label, against the same payload the flat statement
 * was rendered from.
 *
 * --- WHY THIS FILE EXECUTES RATHER THAN GREPS -------------------------------------------------
 *
 * Every assertion CALLS `receiptBodyMarkup` - the client's own renderer, sliced out of
 * `public/app.js` and evaluated against stubs, the harness `tests/ui/payment-receipt.test.ts`
 * established. A source-literal assertion could not fail for the reason this file exists: it would
 * pass while the renderer emitted the rows in the wrong order and fail merely because somebody
 * reindented a template.
 *
 * Four behaviours have a stated mutation that makes them fail, each run against this file and then
 * reverted:
 *
 *   1. the groups exist and are ordered   - drop the three `<h4 class="receipt-group">` headings
 *   2. one emphasised final total         - put `.receipt-total` back on the Balance row as well
 *   3. no `Subtotal` above an equal Total - force `moved` true, restoring the always-drawn subtotal
 *   4. the pet is gated on presence       - drop the `name?` guard in `receiptItemPetMarkup`
 *
 * THIS IS THE SHARED STATEMENT AND IT HAS THREE HOSTS - the Invoice workspace, the settled Check
 * Out panel and the print root. That the three agree cell for cell is
 * `tests/e2e/ticket-surface.spec.ts`, in a browser, against a real invoice. What is asserted here
 * is what the one renderer produces, which is what all three then show.
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

const GATES = slice("function receiptHasPayment(", "\nfunction toast(");
const REFUNDS = slice("function receiptRefundsFor(", "\nfunction salonIdentityOf(");
const RENDERERS = slice(
  "function salonIdentityOf(",
  "\n// Scoped to the copy of the receipt that was just rendered"
);

interface Statement {
  receiptBodyMarkup(receipt: unknown): string;
}

/** The actor. Void and Refund are the Invoice's own corrections and have their own spec. */
function loadClient({ corrections = false } = {}): Statement {
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const escapeAttr = (value = "") =>
    escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const prelude = `
    "use strict";
    const money = (minor) => "$" + (Number(minor || 0) / 100).toFixed(2);
    const clientName = (record) =>
      [record.firstName, record.lastName].filter(Boolean).join(" ").trim() || "Not set";
    const allowed = () => ${corrections ? "true" : "false"};
    const paymentMethodLabel = (method) =>
      ({cash:"Cash",external_card:"Card",check:"Check",other:"Other",client_credit:"Client credit"})[method]
        || String(method || "").replaceAll("_", " ");
    const formatPrefDateAndTime = (instant) => instant.toISOString();
    const formatPrefDate = (instant) => instant.toISOString().slice(0, 10);
    const taxPayPercent = (basisPoints) => (Number(basisPoints || 0) / 100).toFixed(2);
    const invoiceStatusLabel = (status) => String(status || "");
  `;
  const factory = new Function(
    "escape",
    "escapeAttr",
    [prelude, GATES, REFUNDS, RENDERERS, "return { receiptBodyMarkup };"].join("\n")
  ) as (escape: unknown, escapeAttr: unknown) => Statement;
  return factory(escape, escapeAttr);
}

/** One service line as `GET /api/invoices/:id/receipt` sends it, pet and all. */
function item(description: string, amountMinor: number, petName: string | null = null) {
  return { description, amountMinor, petName };
}

/**
 * THE OWNER'S OWN BILL. Every figure on the breakdown she reported, unchanged: an $85.00 groom, a
 * $10.00 named discount, a compounding 15% that took $11.25, $5.26 of tax, a $10.00 tip, a $79.01
 * total and a $79.01 balance behind a payment that was voided.
 */
function reportedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    invoice: {
      invoiceNumber: 1042,
      firstName: "Emma",
      lastName: "Johnson",
      businessName: "Riverside Grooming",
      businessPhone: "626-555-0101",
      businessEmail: "hello@riverside.example",
      locationAddress: "18 Mill Lane, Riverside",
      subtotalMinor: 8500,
      discountMinor: 2125,
      taxMinor: 526,
      tipMinor: 1000,
      totalMinor: 7901,
      balanceMinor: 7901,
      status: "open",
      createdAt: "2026-09-02T18:00:00.000Z",
      ...overrides
    },
    items: [item("Full Groom", 8500)] as ReturnType<typeof item>[],
    discounts: [
      { nameSnapshot: "Senior pet discount", kindSnapshot: "amount", appliedMinor: 1000 },
      {
        nameSnapshot: "Welcome 15%",
        kindSnapshot: "percentage",
        rateBasisPointsSnapshot: 1500,
        appliedMinor: 1125
      }
    ] as Record<string, unknown>[],
    payments: [
      {
        id: "8f1c2ade-0000-4000-8000-000000000001",
        status: "voided",
        method: "external_card",
        amountMinor: 7901,
        recordedAt: "2026-09-02T19:30:00.000Z",
        provider: null,
        providerPaymentId: null,
        externalReference: null,
        providerTipMinor: null
      }
    ],
    refunds: [],
    refundedMinor: 0
  };
}

/** A bill with nothing to move the subtotal: no discount, no tax, no tip. */
function plainInvoice() {
  const receipt = reportedInvoice({
    discountMinor: 0,
    taxMinor: 0,
    tipMinor: 0,
    totalMinor: 8500,
    balanceMinor: 8500
  });
  receipt.discounts = [];
  return receipt;
}

/** Every money row of the statement, in document order, as `label | amount`. */
function rows(markup: string): string[] {
  return [...markup.matchAll(/<div[^>]*>(?:(?!<div)[\s\S])*?<\/div>/gu)]
    .map((match) => match[0])
    .filter((row) => /<span>/u.test(row) && /<strong>/u.test(row))
    .map((row) => {
      const label = /<span>([\s\S]*?)<\/span>/u.exec(row)?.[1] ?? "";
      const amount = /<strong>([\s\S]*?)<\/strong>/u.exec(row)?.[1] ?? "";
      return `${label.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim()} | ${amount.trim()}`;
    });
}

/** The group headings, in document order. */
function groups(markup: string): string[] {
  return [...markup.matchAll(/<h4 class="receipt-group"[^>]*>([^<]*)<\/h4>/gu)].map((m) => m[1]!);
}

/** The rendered value of one labelled row, or `null` when the row was not drawn at all. */
function value(markup: string, testid: string): string | null {
  const row = new RegExp(`<div[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</div>`, "u")
    .exec(markup)?.[1];
  if (row === undefined) return null;
  return /<strong>([\s\S]*?)<\/strong>/u.exec(row)?.[1] ?? null;
}

/** The classes one labelled row was rendered with. */
function classesOf(markup: string, testid: string): string[] {
  const opening = new RegExp(`<div([^>]*)data-testid="${testid}"`, "u").exec(markup)?.[1] ?? "";
  return (/class="([^"]*)"/u.exec(opening)?.[1] ?? "").split(/\s+/u).filter(Boolean);
}

describe("the statement reads as grouped sections", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: delete the three `<h4 class="receipt-group">` headings. The
   * statement still states every figure and is exactly the flat column the owner reported.
   */
  it("heads Services, Discounts and Payment records, in that order", () => {
    const markup = loadClient().receiptBodyMarkup(reportedInvoice());
    expect(groups(markup)).toEqual(["Services", "Discounts", "Payment records"]);
  });

  it("indents the members of a group and outdents the sum that closes one", () => {
    const markup = loadClient().receiptBodyMarkup(reportedInvoice());

    // A member: a service, a discount step, a payment record.
    expect(classesOf(markup, "receipt-item")).toContain("receipt-line");
    expect(classesOf(markup, "receipt-discount")).toContain("receipt-line");
    expect(classesOf(markup, "receipt-payment")).toContain("receipt-line");

    // A sum, and the statement's own calculation lines. Neither is a member of anything.
    for (const testid of [
      "receipt-service-subtotal", "receipt-discount-total", "receipt-tax", "receipt-tip",
      "receipt-invoice-total", "receipt-balance"
    ]) {
      expect(classesOf(markup, testid), testid).not.toContain("receipt-line");
    }
  });

  /**
   * The whole statement, once, as one reader sees it. The rows the owner listed are all here and
   * every figure is the one she reported - this is the flatness fixed, not the arithmetic changed.
   */
  it("renders the reported bill in the order and the figures the owner reported", () => {
    expect(rows(loadClient().receiptBodyMarkup(reportedInvoice()))).toEqual([
      "Full Groom | $85.00",
      "Service subtotal | $85.00",
      "Senior pet discount | -$10.00",
      "Welcome 15% 15.00% | -$11.25",
      "Total discount | -$21.25",
      "Tax | $5.26",
      "Tip | $10.00",
      "Invoice total | $79.01",
      "Balance | $79.01",
      "Card · voided | $79.01"
    ]);
  });

  it("keeps the payment records below every calculation row, never interleaved with them", () => {
    const markup = loadClient().receiptBodyMarkup(reportedInvoice());
    expect(markup.indexOf('data-testid="receipt-balance"'))
      .toBeLessThan(markup.indexOf(">Payment records<"));
    expect(markup.indexOf(">Payment records<"))
      .toBeLessThan(markup.indexOf('data-testid="receipt-payment"'));
  });
});

describe("exactly one emphasised final total, and it is the Invoice total", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: put `.receipt-total` on the Balance row as well. Two shouted
   * figures answering two different questions is what "which of these is the total" looks like.
   */
  it("gives `.receipt-total` to Invoice total and to nothing else", () => {
    const markup = loadClient().receiptBodyMarkup(reportedInvoice());
    expect(markup.match(/class="receipt-total"/gu)).toHaveLength(1);
    expect(classesOf(markup, "receipt-invoice-total")).toEqual(["receipt-total"]);
    expect(value(markup, "receipt-invoice-total")).toBe("$79.01");
  });

  it("calls it `Invoice total`, the name the workspace's own summary already uses", () => {
    const markup = loadClient().receiptBodyMarkup(reportedInvoice());
    expect(markup).toContain("<span>Invoice total</span>");
    // And never a bare `Total`, which is the label the flat statement carried.
    expect(markup).not.toContain("<span>Total</span>");
  });

  it("keeps Balance separate, in its own weight, saying what is owed now", () => {
    const markup = loadClient().receiptBodyMarkup(reportedInvoice());
    expect(classesOf(markup, "receipt-balance")).toEqual(["receipt-balance"]);
    expect(value(markup, "receipt-balance")).toBe("$79.01");
    // It follows the total rather than replacing it: what the visit came to, then what is open.
    expect(markup.indexOf('data-testid="receipt-invoice-total"'))
      .toBeLessThan(markup.indexOf('data-testid="receipt-balance"'));
  });

  it("still states a settled balance of zero rather than withdrawing the line", () => {
    // Balance is a fact about the bill in every state, and "nothing is owed" is a fact worth
    // stating on a document somebody is reading to find out.
    const markup = loadClient().receiptBodyMarkup(reportedInvoice({ balanceMinor: 0 }));
    expect(value(markup, "receipt-balance")).toBe("$0.00");
  });
});

describe("the generic Subtotal is gone, and Service subtotal earns its place", () => {
  /**
   * MUTATION THAT MUST FAIL THIS: force `moved` to `true`, restoring the always-drawn subtotal.
   * The plain bill then states $85.00 twice under two names, which is the case the owner named.
   */
  it("draws no subtotal at all when nothing downstream moves it", () => {
    const markup = loadClient().receiptBodyMarkup(plainInvoice());
    expect(value(markup, "receipt-service-subtotal")).toBeNull();
    expect(markup).not.toContain("subtotal");
    // The one figure is stated once as a total, under the name that says what it is. Balance
    // repeats it because it is answering the other question - all $85.00 of this bill is open -
    // and that is not the same claim twice.
    expect(value(markup, "receipt-invoice-total")).toBe("$85.00");
    expect(rows(markup).filter((row) => row.endsWith("| $85.00"))).toEqual([
      "Full Groom | $85.00",
      "Invoice total | $85.00",
      "Balance | $85.00"
    ]);
  });

  it("draws it, named for what it is a subtotal OF, once a discount, tax or tip moves it", () => {
    const client = loadClient();
    const cases: [string, Record<string, unknown>][] = [
      ["a discount", { discountMinor: 500, taxMinor: 0, tipMinor: 0, totalMinor: 8000, balanceMinor: 8000 }],
      ["tax", { discountMinor: 0, taxMinor: 701, tipMinor: 0, totalMinor: 9201, balanceMinor: 9201 }],
      ["a tip", { discountMinor: 0, taxMinor: 0, tipMinor: 500, totalMinor: 9000, balanceMinor: 9000 }]
    ];
    for (const [why, overrides] of cases) {
      const receipt = reportedInvoice(overrides);
      if (!Number(overrides.discountMinor)) receipt.discounts = [];
      const markup = client.receiptBodyMarkup(receipt);
      expect(value(markup, "receipt-service-subtotal"), why).toBe("$85.00");
      expect(markup, why).toContain("<span>Service subtotal</span>");
      expect(markup, why).not.toContain("<span>Subtotal</span>");
    }
  });

  it("never states a subtotal directly above a total reading the same figure", () => {
    const client = loadClient();
    for (const receipt of [reportedInvoice(), plainInvoice()]) {
      const drawn = rows(client.receiptBodyMarkup(receipt));
      const subtotal = drawn.findIndex((row) => row.startsWith("Service subtotal |"));
      if (subtotal < 0) continue;
      const total = drawn.findIndex((row) => row.startsWith("Invoice total |"));
      expect(drawn[subtotal]!.split(" | ")[1]).not.toBe(drawn[total]!.split(" | ")[1]);
    }
  });
});

describe("what the grouping was not allowed to lose", () => {
  it("preserves every discount name, its rate and its amount, in applied order", () => {
    const markup = loadClient().receiptBodyMarkup(reportedInvoice());
    expect(rows(markup).filter((row) => row.includes("-$"))).toEqual([
      "Senior pet discount | -$10.00",
      "Welcome 15% 15.00% | -$11.25",
      "Total discount | -$21.25"
    ]);
    expect(markup.indexOf("Senior pet discount")).toBeLessThan(markup.indexOf("Welcome 15%"));
  });

  it("keeps a voided payment on the statement, named by its status and at its amount", () => {
    const markup = loadClient({ corrections: true }).receiptBodyMarkup(reportedInvoice());
    expect(rows(markup)).toContain("Card · voided | $79.01");
    // And offers no further correction on it: a voided record is already corrected, and the one
    // control this row could carry would only reach a refusal.
    expect(markup).not.toContain("void-payment");
    expect(markup).not.toContain("refund-payment");
  });

  it("draws no Discounts section at all on a bill that took nothing off", () => {
    // A `Discount -$0.00` row was one of the equal-weight rows the owner was reading past, and a
    // "Discounts" heading over it would announce a section about nothing.
    const markup = loadClient().receiptBodyMarkup(plainInvoice());
    expect(groups(markup)).toEqual(["Services", "Payment records"]);
    expect(markup).not.toContain("Discount");
  });

  it("keeps every host reading the same statement - one renderer, no branch on the caller", () => {
    // `receiptBodyMarkup` takes the receipt and nothing else. There is no host argument to branch
    // on, so the Invoice workspace, the settled Check Out panel and the print root cannot be given
    // three different shapes; `tests/e2e/ticket-surface.spec.ts` proves that in a browser.
    expect(loadClient().receiptBodyMarkup.length).toBe(1);
  });
});

describe("which pet a service line was for", () => {
  it("names the pet beside the service when the line's own source names one", () => {
    const receipt = reportedInvoice();
    receipt.items = [item("Flea + Tick", 4000, "Barfi"), item("Full Groom", 4500, "Mochi")];
    const markup = loadClient().receiptBodyMarkup(receipt);
    expect(rows(markup).slice(0, 2)).toEqual([
      "Flea + Tick (for Barfi) | $40.00",
      "Full Groom (for Mochi) | $45.00"
    ]);
  });

  /**
   * MUTATION THAT MUST FAIL THIS: drop the `name?` guard in `receiptItemPetMarkup`. A manual line
   * then renders `Studio fee (for )`, which reads as a broken template rather than as a line with
   * no pet.
   */
  it("draws nothing at all - no parenthetical, no dash - when the line names no pet", () => {
    const receipt = reportedInvoice();
    receipt.items = [item("Studio fee", 2000, null)];
    const markup = loadClient().receiptBodyMarkup(receipt);
    expect(rows(markup)[0]).toBe("Studio fee | $20.00");
    expect(markup).not.toContain("(for");
    expect(markup).not.toContain("receipt-item-pet");
  });

  it("never borrows another line's pet for a line that has none", () => {
    // The endpoint resolves the pet from THE LINE'S OWN source service, so a manual line beside a
    // pet's groom is a line about no pet - not a second line about that pet.
    const receipt = reportedInvoice();
    receipt.items = [item("Full Groom", 8500, "Barfi"), item("Studio fee", 2000, null)];
    const markup = loadClient().receiptBodyMarkup(receipt);
    expect(rows(markup).slice(0, 2)).toEqual([
      "Full Groom (for Barfi) | $85.00",
      "Studio fee | $20.00"
    ]);
    expect(markup.match(/\(for /gu)).toHaveLength(1);
  });

  it("escapes a pet name, which is operator-entered text", () => {
    // Through `escape`, the text-node escaper, exactly as the service description beside it goes:
    // the name is content rather than an attribute value, so the angle brackets are neutralised
    // and a quotation mark in a pet name stays a quotation mark.
    const receipt = reportedInvoice();
    receipt.items = [item("Full Groom", 8500, '<script>"Rex"')];
    const markup = loadClient().receiptBodyMarkup(receipt);
    expect(markup).toContain('(for &lt;script&gt;"Rex")');
    expect(markup).not.toContain("<script>");
  });
});
