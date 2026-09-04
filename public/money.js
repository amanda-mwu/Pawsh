/**
 * Currency presentation for the web client.
 *
 * THIS IS THE BROWSER'S COPY OF `formatMinor` IN `packages/domain/src/labels.ts`, WHICH IS THE
 * AUTHORITY. `public/app.js` is served as a plain ES module with no bundler, so it cannot import
 * from the workspace package; splitting the one function it needs into a file of its own is what
 * lets the web have a single definition without a build step, and what lets a test load the exact
 * code the browser runs instead of slicing it back out of a 13,000-line file.
 *
 * THE COPY IS GUARDED, NOT TRUSTED. `tests/domain/web-money-parity.test.mjs` imports this module
 * and the domain's `formatMinor` side by side and asserts they agree character for character over
 * every supported currency and a matrix of amounts, and it reads `public/app.js` to assert nothing
 * there builds a currency formatter of its own. The two cannot silently diverge again.
 *
 * THE TWO FRACTION DIGITS ARE PINNED, and that is the whole reason this file exists. Left to
 * itself `Intl.NumberFormat` applies CLDR's DISPLAY convention for the currency - how many decimals
 * a place actually shows - rather than the exponent ISO 4217 defines. Fifteen supported codes
 * disagree (`currenciesWithoutMinorUnitDisplay` in `packages/domain/src/currency.ts` names them),
 * and unpinned the web rounded them to whole units while the domain and the mobile app did not:
 * 9999 minor units of COP printed as "COP 100" in the browser and "COP 99.99" everywhere else, on
 * a receipt a client pays against. Pinning states what the money model already is - minor units
 * over one hundred, always - and needs no currency list to do it, which is why there is none here.
 *
 * NOTHING HERE ROUNDS OR TOTALS MONEY. Input is always the integer minor units the API returns and
 * the arithmetic is done before it arrives; this decides only how the number is written down.
 */

/**
 * An integer minor-unit amount, written the way the operator's workspace spells money.
 *
 * The `try/catch` mirrors the domain's, for the same reason: a runtime with a reduced ICU can
 * throw on a currency it does not know, and a readable plain-decimal fallback beats a blank cell
 * on a document somebody is holding.
 */
export function formatMinor(valueMinor, currency = "USD") {
  const amount = Number(valueMinor ?? 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * The currency's own symbol, taken from the same formatter rather than assumed.
 *
 * Built here so the symbol a field's suffix shows and the amount beside it are read out of one
 * configuration. A hard-coded `$` would be wrong for every salon not billing in dollars.
 */
export function currencySymbolFor(currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2
    }).formatToParts(0).find((part) => part.type === "currency")?.value || currency;
  } catch {
    return currency;
  }
}
