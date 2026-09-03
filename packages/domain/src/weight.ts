/**
 * The unit a workspace reads pet weights in, and the conversion that keeps the PRICE TIERS honest
 * when it changes.
 *
 * `pets.weight_ounces` is the canonical stored unit and this file does not move it. Ounces are an
 * integer, they are what `resolveWeightTier` compares against, and they are what every price tier
 * a salon has ever configured was resolved through. `weightUnit` is a PRESENTATION setting: it
 * decides what an operator reads, never what the database holds and never which tier a pet lands
 * in. A workspace can switch it twice a day and no price moves.
 *
 * THE PART THAT IS EASY TO GET WRONG. The six weight tiers are defined in ounces but they were
 * CHOSEN in pounds - 320, 640, 960, 1280, 1600 are 20, 40, 60, 80 and 100 lb, and their labels say
 * so. Converting a pet's displayed weight to kilograms while leaving those labels in pounds is
 * worse than converting nothing: the screen then shows a 19.1 kg dog sitting in a band captioned
 * "21-40 lb", and the operator cannot tell whether the tier is wrong, the weight is wrong, or the
 * salon is being charged for the wrong band. So the band labels are DERIVED from the same
 * boundaries and the same unit as the weight, by the function below, and there is a test asserting
 * that the derivation reproduces the existing pound labels character for character. The tier
 * bounds and their captions cannot drift apart because there is now only one of them.
 *
 * The kilogram bands are not round numbers, and that is correct rather than sloppy. The pricing
 * boundary genuinely falls at 320 oz, which is genuinely 9.07 kg. Rounding the band to a tidy
 * 9 kg or 10 kg would MOVE A PRICE BOUNDARY for pets already on the books. Redefining the tiers in
 * kilograms is a product decision with a repricing behind it, not a display change, and it is not
 * taken here.
 *
 * Both units round for display, so a weight within half a display step of a boundary can read as
 * the boundary while resolving to the neighbouring tier. That is inherent to displaying a rounded
 * number beside an exactly-compared one and it predates this file - a 20.4 lb dog already displays
 * "20.4 lb" against a band captioned "21-40 lb" today. The ounce comparison is the authority in
 * every case.
 */

/** Exact avoirdupois definition: one ounce is 28.349523125 grams, by treaty, not by approximation. */
const GRAMS_PER_OUNCE = 28.349523125;
const OUNCES_PER_POUND = 16;

export const weightUnits = ["lb", "kg"] as const;
export type WeightUnit = typeof weightUnits[number];

const supportedWeightUnits = new Set<string>(weightUnits);
export function isWeightUnit(value: string): value is WeightUnit {
  return supportedWeightUnits.has(value);
}

/**
 * How each unit is written down.
 *
 * `bandDecimals` is the precision the TIER CAPTIONS use and `valueDecimals` the precision a single
 * pet's weight uses. They differ for pounds on purpose: the captions have read "1-20 lb" since the
 * tiers were defined and changing them to "1.0-20.0 lb" would be a gratuitous product change,
 * while a small dog genuinely needs a decimal to not read as "4 lb" when it is 3.5.
 */
const unitShape: Record<WeightUnit, { ouncesPer: number; bandDecimals: number; valueDecimals: number }> = {
  lb: { ouncesPer: OUNCES_PER_POUND, bandDecimals: 0, valueDecimals: 1 },
  kg: { ouncesPer: 1000 / GRAMS_PER_OUNCE, bandDecimals: 1, valueDecimals: 1 }
};

/** The stored ounces expressed in the workspace's unit, unrounded. */
export function weightFromOunces(
  weightOunces: number | null | undefined, unit: WeightUnit
): number | null {
  if (weightOunces === null || weightOunces === undefined) return null;
  const ounces = Number(weightOunces);
  return Number.isFinite(ounces) ? ounces / unitShape[unit].ouncesPer : null;
}

/**
 * The inverse, for a value an operator typed. Rounds to whole ounces because that is the column's
 * type, so a round trip through the form is stable to within half an ounce in either unit.
 */
export function ouncesFromWeight(
  value: number | null | undefined, unit: WeightUnit
): number | null {
  if (value === null || value === undefined) return null;
  const entered = Number(value);
  if (!Number.isFinite(entered) || entered < 0) return null;
  return Math.round(entered * unitShape[unit].ouncesPer);
}

/** Trims a trailing `.0` so a whole weight reads "42 lb" rather than "42.0 lb". */
function trim(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/** A single pet's weight, with its unit: "42 lb", "3.5 lb", "19.1 kg". */
export function formatWeight(
  weightOunces: number | null | undefined, unit: WeightUnit
): string | null {
  const value = weightFromOunces(weightOunces, unit);
  if (value === null) return null;
  return `${trim(value.toFixed(unitShape[unit].valueDecimals))} ${unit}`;
}

/** The bounds a tier is defined by, structurally, so this file need not import `pricing.ts`. */
export interface WeightBand {
  readonly minExclusiveOunces: number;
  readonly maxOunces: number | null;
}

/**
 * The caption for one tier, in the workspace's unit.
 *
 * Bounds are held in integer display STEPS rather than floats so that repeatedly adding one step
 * cannot accumulate a `9.200000000000001`. A step is one pound or one tenth of a kilogram.
 *
 * The shape reproduces the convention the pound labels already set: the printed lower bound is one
 * step above the tier's exclusive minimum, the printed upper bound is the tier's inclusive maximum,
 * and the open-ended tier is written as its predecessor's maximum followed by `+`. Applied to
 * pounds that yields exactly "1-20", "21-40", "41-60", "61-80", "81-100", "100+", which is what
 * `weightTiers` has always said. Applied to kilograms it yields "0.1-9.1", "9.2-18.1", "18.2-27.2",
 * "27.3-36.3", "36.4-45.4", "45.4+".
 */
export function weightTierLabel(band: WeightBand, unit: WeightUnit): string {
  const { ouncesPer, bandDecimals } = unitShape[unit];
  const stepsPerUnit = 10 ** bandDecimals;
  const toSteps = (ounces: number) => Math.round((ounces / ouncesPer) * stepsPerUnit);
  const print = (steps: number) => (steps / stepsPerUnit).toFixed(bandDecimals);
  const lowerSteps = toSteps(band.minExclusiveOunces) + 1;
  if (band.maxOunces === null) return `${print(lowerSteps - 1)}+ ${unit}`;
  return `${print(lowerSteps)}–${print(toSteps(band.maxOunces))} ${unit}`;
}

/**
 * Every tier's caption in one call, which is the shape `/api/me` publishes.
 *
 * The clients hold three hand-copied duplicates of these bands today - the pricing matrix and the
 * service editor in the web app each restate them, neither importing the domain constant - so the
 * server publishing the derived list is what lets those become one source instead of four.
 */
export function weightTierLabels<T extends WeightBand & { code: string }>(
  bands: readonly T[], unit: WeightUnit
): { code: T["code"]; label: string }[] {
  return bands.map((band) => ({ code: band.code, label: weightTierLabel(band, unit) }));
}
