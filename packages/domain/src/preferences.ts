/**
 * The closed sets Settings -> Business chooses from.
 *
 * Every tuple here is declared once and consumed three ways: the zod schema derives its enum from
 * it, the check constraint in migration 0047 spells the same strings, and any client renders its
 * picker from what `/api/me` reports. That is the arrangement `permissions`, `pricingClasses` and
 * `supportedCurrencies` already use, and the reason for it is the same - a value an operator can
 * select must be a value the server accepts and the database will store, and three hand-kept
 * copies of a list drift.
 *
 * The strings ARE the stored values and the wire values, with no mapping layer. `weightUnits`
 * lives in `weight.ts` instead, next to the conversion that gives it meaning.
 */

/**
 * How the salon operates. Storage and API only - nothing branches on it yet.
 *
 * 'hybrid' is a salon that also runs a van, which is why it is one value rather than a pair of
 * booleans: an operator picks what their business IS, and the three states are exhaustive.
 */
export const businessTypes = ["mobile", "salon", "hybrid"] as const;
export type BusinessType = typeof businessTypes[number];

/**
 * Date ordering, honoured by every server-rendered date. See `src/domain/date-format.ts`.
 *
 * The values are the patterns themselves rather than names like 'us'/'international', so what an
 * operator picked and what a receipt prints are the same string and no lookup table sits between
 * them to be got wrong.
 */
export const dateFormats = ["MM/DD/YYYY", "DD/MM/YYYY"] as const;
export type DateFormat = typeof dateFormats[number];

/** 12- or 24-hour clock, honoured alongside `dateFormats`. Strings, because they are stored as such. */
export const hourFormats = ["12", "24"] as const;
export type HourFormat = typeof hourFormats[number];

/**
 * STORED, RETURNED, AND ENFORCED NOWHERE.
 *
 * Deliberate and not an oversight. What an appointment lock should actually PREVENT - editing a
 * past appointment, editing a completed one, editing one whose invoice is settled, rescheduling
 * inside the reminder window - are four different rules with four different blast radii, and
 * guessing would put a refusal in front of an operator that nobody designed. The column is here so
 * the setting is real storage the moment the semantics are decided, and the API returns it so a
 * client can show what was chosen. No handler reads it.
 */
export const appointmentLockModes = ["enabled", "disabled"] as const;
export type AppointmentLockMode = typeof appointmentLockModes[number];

/**
 * How coupons combine. Stored now, honoured when coupons exist.
 *
 * Pawsh has no coupon domain: `invoices` carries a single `discount` integer applied before tax in
 * `calculateInvoice`, and there is no coupon table, no code, no stacking to arbitrate. This tuple
 * records the rule a salon has chosen so that whatever builds coupons inherits an answer instead
 * of asking again.
 *
 *   single           - one coupon or discount per appointment, no combining
 *   amount_first     - combine, applying fixed-amount discounts before percentage ones
 *   percentage_first - combine, applying percentage discounts before fixed-amount ones
 */
export const couponStackingModes = ["single", "amount_first", "percentage_first"] as const;
export type CouponStackingMode = typeof couponStackingModes[number];

/**
 * How many upcoming appointments a public send-out link would list. Stored now, honoured when such
 * a link exists.
 *
 * Pawsh has no public, unauthenticated client-facing surface at all - the report card "preview" is
 * a staff page behind the ordinary session, with no token and no shareable URL - so there is
 * nothing today that lists a client's upcoming appointments to them and could be limited.
 *
 * `null` MEANS "All", and that is the stored default. It is not a stand-in for "unset": a
 * workspace that has never opened this screen behaves as "All" already, so the absent value and
 * the chosen value coincide rather than needing a sentinel. A number is 1-20 inclusive.
 */
export const upcomingAppointmentCountAll = null;
export const upcomingAppointmentCountMax = 20;
