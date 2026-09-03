/**
 * The currencies a Pawsh workspace may be set to.
 *
 * The gate is NOT "is this a real ISO 4217 code". It is "can Pawsh represent money in it without
 * lying". Every amount in this product is an integer number of MINOR UNITS and every reader
 * divides by exactly one hundred - `formatMinor` in `labels.ts`, the price editors in the web and
 * mobile clients, the invoice arithmetic in `money.ts`, the Square line items. Nothing anywhere
 * consults a per-currency exponent. A zero-decimal currency (JPY, KRW, CLP) would therefore render
 * every price a hundred times too small, and a three-decimal one (KWD, BHD, OMR) ten times too
 * large, on invoices, receipts, payments and refunds alike. Those are not display bugs. They are
 * wrong numbers on a document a salon hands a paying client.
 *
 * MEMBERSHIP RULE, in three parts. A code is here when all three hold:
 *
 *   1. It is an ACTIVE ISO 4217 code (Table A.1, "list one"). Withdrawn codes are excluded even
 *      though ICU still carries them: ANG (replaced by XCG, 2025), HRK (Croatia adopted the euro,
 *      2023), CUC (withdrawn 2021), SLL (redenominated to SLE, which IS here), ZWL (replaced by
 *      ZWG, 2024). A picker offering a currency that no longer exists is a picker a salon can pick
 *      wrong from.
 *   2. Its ISO 4217 MINOR UNIT is exactly 2. This is the money-model rule above and the only one
 *      that can produce a wrong number. It excludes the ~20 zero-decimal codes (BIF CLP DJF GNF
 *      ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF), the seven three-decimal ones (BHD IQD
 *      JOD KWD LYD OMR TND), the four-decimal ones (CLF UYW), and every "N.A." code - the precious
 *      metals (XAU XAG XPT XPD), the bond-market units (XBA-XBD), XDR, XSU, XUA, and the
 *      no-currency placeholders (XTS XXX).
 *   3. It is a currency a salon could actually invoice in. This drops the six minor-unit-2 FUND
 *      AND SETTLEMENT codes - BOV, CHE, CHW, COU, MXV, USN. "US Dollar (Next day)" is an
 *      accounting unit for securities settlement, not something a groomer charges for a bath, and
 *      six of them in a list of 132 is noise with no legitimate selection behind it.
 *
 * That yields the 132 codes below, alphabetically ordered, which is the whole list and not a
 * sample of it. `supported-currencies.test.ts` re-derives the minor-unit property against
 * `Intl.NumberFormat` rather than trusting this comment.
 *
 * ICU IS NOT ISO, AND THE DIFFERENCE MATTERS HERE. `Intl.NumberFormat` reports CLDR's *display*
 * convention, which is how many decimals a place actually shows in practice, not the exponent ISO
 * defines. Fifteen codes here have an ISO minor unit of 2 while CLDR formats them with none,
 * because the subunit has been inflated into irrelevance: AFN, ALL, COP, HUF, IDR, IRR, KPW, LAK,
 * LBP, MGA, MMK, PKR, SOS, SYP, YER. They are correct members - a hundred minor units really is
 * one AFN - but they are the reason `formatMinor` now PINS two fraction digits. Left to CLDR, 1250
 * minor units of AFN rendered as "AFN 13": a rounded number on an invoice. See the note there.
 *
 * Adding a code is a one-line change here and never a migration - the same arrangement
 * `groomerPaletteSize` and the permission tuple use, so the picker an operator sees and the set
 * the server accepts are derived from one declaration and cannot drift apart. The server reports
 * the list on `/api/me` rather than each client restating it, which is the same reasoning as
 * `cardProcessing.connectable` on the Tax & payments screen: what the product supports is
 * answered by the product.
 *
 * Deliberately NOT a database check constraint. `businesses.currency` is `char(3)` and has been
 * writable as any three characters since 0001, so what is actually stored across existing
 * workspaces is unverified; a constraint added over it would fail the DEPLOY rather than the
 * request, which is a far worse failure than the one it prevents. `businessSettingsSchema` treats
 * an omitted currency as "leave it alone" for the same reason - a workspace holding a legacy
 * value can still rename itself, and only a caller that actually operates the picker is held to
 * this list.
 */
export const supportedCurrencies = [
  "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM",
  "BBD", "BDT", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN",
  "BZD", "CAD", "CDF", "CHF", "CNY", "COP", "CRC", "CUP", "CVE", "CZK",
  "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP",
  "GEL", "GHS", "GIP", "GMD", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF",
  "IDR", "ILS", "INR", "IRR", "JMD", "KES", "KGS", "KHR", "KPW", "KYD",
  "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "MAD", "MDL", "MGA", "MKD",
  "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN",
  "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "PAB", "PEN", "PGK", "PHP",
  "PKR", "PLN", "QAR", "RON", "RSD", "RUB", "SAR", "SBD", "SCR", "SDG",
  "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP",
  "SZL", "THB", "TJS", "TMT", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH",
  "USD", "UYU", "UZS", "VED", "VES", "WST", "XCD", "XCG", "YER", "ZAR",
  "ZMW", "ZWG"
] as const;

export type SupportedCurrency = typeof supportedCurrencies[number];

/**
 * The fifteen members whose CLDR display convention shows no decimals even though their ISO 4217
 * minor unit is two.
 *
 * THIS LIST IS ABOUT PRESENTATION, NOT PRECISION. Every code here is stored and arithmetic'd in
 * two-decimal minor units exactly like every other supported currency; all that differs is how
 * many decimals `Intl` chooses to print. Nothing may read this list to decide how to store, round
 * or total money.
 *
 * Named here, and asserted in the test, so that the cross-check against `Intl` stays a real check
 * rather than one loosened until it passed. Every entry is an ISO-2 code; a code with an ISO minor
 * unit of 0 or 3 may never be added to this list, because that is precisely the class of mistake
 * the check exists to catch. Exported so the test can assert the two sets partition exactly.
 *
 * CLDR MOVES, AND THIS LIST MOVES WITH IT. `COP`, `HUF`, `IDR` and `PKR` joined when a newer ICU
 * began printing them without their subunits, and `RSD` left when the same release started printing
 * the dinar with its para again. Every one of those five still has an ISO minor unit of two, so the
 * membership rule above is untouched: what changed is CLDR's presentation, not the money.
 *
 * The symptom of the next such change is this list's own test failing on a code it names or omits.
 * That is the check working, and the fix is to decide which side of the list the code now belongs
 * on - never to relax the comparison, which would let a genuinely zero-decimal code through.
 */
export const currenciesWithoutMinorUnitDisplay = [
  "AFN", "ALL", "COP", "HUF", "IDR", "IRR", "KPW", "LAK", "LBP", "MGA", "MMK", "PKR", "SOS",
  "SYP", "YER"
] as const;

const supported = new Set<string>(supportedCurrencies);

/** Membership test for an already-uppercased three-letter code. */
export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return supported.has(value);
}
