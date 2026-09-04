import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  currenciesWithoutMinorUnitDisplay, formatMinor as domainFormatMinor, supportedCurrencies
} from "@pawsh/domain";
import { currencySymbolFor, formatMinor as webFormatMinor } from "../../public/money.js";

/**
 * ONE CURRENCY PRESENTATION CONTRACT, AND THE GUARD THAT KEEPS IT ONE.
 *
 * `public/app.js` is served to the browser as a plain ES module with no bundler, so it cannot
 * import from `@pawsh/domain` and the web's money formatter has to be a copy. A copy nobody
 * compares is a copy that drifts, and this one did: `money()` built an `Intl.NumberFormat` without
 * pinning the fraction digits, so `Intl` applied CLDR's DISPLAY convention and rounded the fifteen
 * codes in `currenciesWithoutMinorUnitDisplay` to whole units. The same 9999 minor units printed
 * "COP 100" in the browser and "COP 99.99" on the phone and in every server-rendered figure - on a
 * document a client pays against.
 *
 * The fix was NOT a second currency allowlist in the browser. Pinning two fraction digits makes
 * the CLDR convention irrelevant, so there is exactly one list of exceptions in the product and it
 * lives in `packages/domain/src/currency.ts` where nothing reads it to make a decision about
 * money. This file asserts three things, and it is the reason the copy cannot silently diverge
 * again:
 *
 *   1. the web module and the domain agree CHARACTER FOR CHARACTER, over every supported currency
 *      and a matrix of amounts including negatives, zero and mixed-payment invoice figures;
 *   2. `public/app.js` builds no currency formatter of its own - every amount it writes goes
 *      through the shared module;
 *   3. the shared module pins the digits and names no currency, so it cannot grow a second list.
 *
 * PRESENTATION ONLY. Nothing here, and nothing in either formatter, rounds or totals money: the
 * input is always the exact integer minor units the API sent.
 */

/**
 * U+00A0 NO-BREAK SPACE, which is what `Intl` puts between a bare currency code and the number.
 *
 * Spelled out rather than typed, because a plain space here would make every "character for
 * character" assertion below quietly wrong in a way no diff shows.
 */
const NB = "\u00A0";

const WEB_SOURCE = readFileSync("public/app.js", "utf8");
const MODULE_SOURCE = readFileSync("public/money.js", "utf8");

/** Amounts chosen so a rounding difference of one hundredth cannot hide anywhere. */
const AMOUNTS = [
  0, 1, 5, 49, 50, 99, 100, 999, 1250, 8500, 9999, 10_000, 123_456, 999_999_999,
  -1, -50, -2550, -9999, -123_456
];

describe("web and domain currency presentation", () => {
  it("agrees with the domain on every supported currency and amount", () => {
    for (const currency of supportedCurrencies) {
      for (const amount of AMOUNTS) {
        expect(webFormatMinor(amount, currency), `${currency} ${amount}`)
          .toBe(domainFormatMinor(amount, currency));
      }
    }
  });

  it("agrees on the absent, the null and the undefined amount", () => {
    for (const currency of ["USD", "COP", "HUF"]) {
      expect(webFormatMinor(null, currency)).toBe(domainFormatMinor(null, currency));
      expect(webFormatMinor(undefined, currency)).toBe(domainFormatMinor(undefined, currency));
    }
    // Both default to USD when the workspace has no currency yet, which is what `money()` relies on.
    expect(webFormatMinor(9999)).toBe(domainFormatMinor(9999));
    expect(webFormatMinor(9999)).toBe("$99.99");
  });

  /**
   * The regression itself, written out rather than derived.
   *
   * Deriving every expectation from `Intl` would let the same ICU change move the test and the code
   * together, which is exactly how this defect survived. These are the strings a person reads.
   */
  it("writes the minor units of a CLDR zero-display currency, character for character", () => {
    expect(webFormatMinor(9999, "USD")).toBe("$99.99");
    // The four that joined the exception list when a newer ICU stopped printing their subunits.
    expect(webFormatMinor(9999, "COP")).toBe(`COP${NB}99.99`);
    expect(webFormatMinor(9999, "HUF")).toBe(`HUF${NB}99.99`);
    expect(webFormatMinor(9999, "IDR")).toBe(`IDR${NB}99.99`);
    expect(webFormatMinor(9999, "PKR")).toBe(`PKR${NB}99.99`);
    // Two more of the fifteen, so the assertion does not rest on the four that were reported.
    expect(webFormatMinor(9999, "ALL")).toBe(`ALL${NB}99.99`);
    expect(webFormatMinor(9999, "YER")).toBe(`YER${NB}99.99`);
    // RSD is the control: it LEFT the exception list when ICU began printing the dinar with its
    // para again, so it reads the same pinned or unpinned and must go on reading the same.
    expect(webFormatMinor(9999, "RSD")).toBe(`RSD${NB}99.99`);
    // Zero and a negative, in a currency where the difference used to show.
    expect(webFormatMinor(0, "COP")).toBe(`COP${NB}0.00`);
    expect(webFormatMinor(-2550, "COP")).toBe(`-COP${NB}25.50`);
    expect(webFormatMinor(0, "USD")).toBe("$0.00");
    expect(webFormatMinor(-2550, "USD")).toBe("-$25.50");
  });

  it("would have failed before the digits were pinned", () => {
    // The old expression, kept here as the counter-example. If this ever starts agreeing with the
    // pinned formatter for a code on the exception list, the list is what has moved - not this file.
    const unpinned = (minor, currency) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
    for (const currency of currenciesWithoutMinorUnitDisplay) {
      expect(unpinned(9999, currency), currency).not.toBe(webFormatMinor(9999, currency));
    }
    expect(unpinned(9999, "COP")).toBe(`COP${NB}100`);
  });

  /**
   * A mixed-payment invoice, every figure a receipt or a Ticket-free financial page prints.
   *
   * The numbers are one real bill: an $85.00 groom plus a $20.00 nail trim, $5.00 off, 8.25% tax
   * on what is left, a $15.00 tip, settled with $40.00 of client credit and $75.31 of cash. They
   * are asserted in a zero-display currency because that is where the web and the phone disagreed.
   */
  it("writes every figure of a mixed-payment invoice the way the domain does", () => {
    const invoice = {
      lineOne: 8500, lineTwo: 2000, subtotal: 10_500, discount: 500, tax: 825, tip: 1500,
      total: 11_531, balance: 0, creditPayment: 4000, cashPayment: 7531, refunded: 2550
    };
    for (const currency of ["USD", "COP", "HUF", "IDR", "PKR", "RSD", "ALL"]) {
      for (const [field, minor] of Object.entries(invoice)) {
        expect(webFormatMinor(minor, currency), `${currency} ${field}`)
          .toBe(domainFormatMinor(minor, currency));
      }
    }
    expect(Object.values(invoice).map((minor) => webFormatMinor(minor, "COP"))).toEqual([
      `COP${NB}85.00`, `COP${NB}20.00`, `COP${NB}105.00`, `COP${NB}5.00`, `COP${NB}8.25`, `COP${NB}15.00`,
      `COP${NB}115.31`, `COP${NB}0.00`, `COP${NB}40.00`, `COP${NB}75.31`, `COP${NB}25.50`
    ]);
  });

  it("reads a currency's symbol out of the same configuration", () => {
    expect(currencySymbolFor("USD")).toBe("$");
    expect(currencySymbolFor("EUR")).toBe("€");
    expect(currencySymbolFor("COP")).toBe("COP");
    expect(currencySymbolFor()).toBe("$");
  });
});

describe("the drift guard", () => {
  it("keeps `public/app.js` out of the currency-formatting business", () => {
    // Every amount the web writes goes through the shared module. A second `style: "currency"`
    // formatter in `app.js` is how the first divergence happened, so its reappearance is the
    // failure, not a style preference.
    const formatters = WEB_SOURCE.match(/style\s*:\s*["']currency["']/g) ?? [];
    expect(formatters, "public/app.js must format money through public/money.js").toEqual([]);
    expect(WEB_SOURCE).toContain('import { formatMinor, currencySymbolFor } from "./money.js";');
  });

  it("pins the fraction digits and names no currency", () => {
    expect(MODULE_SOURCE).toContain("minimumFractionDigits: 2, maximumFractionDigits: 2");
    // A SECOND ALLOWLIST IS THE THING THIS DESIGN EXISTS TO AVOID. Pinning needs no list, so any
    // three-letter code appearing as a value in this module is a list starting to grow. The two
    // "USD" default parameters are the exception, and they are the only one.
    const codes = (MODULE_SOURCE.match(/["'][A-Z]{3}["']/g) ?? []).filter((code) => code !== '"USD"');
    expect(codes, "public/money.js must not carry a currency list").toEqual([]);
    expect(MODULE_SOURCE).not.toContain("currenciesWithoutMinorUnitDisplay =");
  });

  it("names the domain as the authority it copies", () => {
    // So the next person to change one knows there is another, and where the test is.
    expect(MODULE_SOURCE).toContain("packages/domain/src/labels.ts");
    expect(MODULE_SOURCE).toContain("tests/domain/web-money-parity.test.mjs");
  });
});
