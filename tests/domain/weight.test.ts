import { describe, expect, it } from "vitest";
import {
  formatWeight, isWeightUnit, ouncesFromWeight, resolveTierPrice, resolveWeightTier,
  weightFromOunces, weightTierLabel, weightTierLabels, weightTiers, weightUnits
} from "@pawsh/domain";

/**
 * The weight unit, and the property that makes it safe to change.
 *
 * The hazard this suite exists for is NOT "does 320 ounces convert to 9.07 kilograms". It is that
 * the six price bands are defined in ounces but were CHOSEN in pounds, and their captions say so.
 * Converting a pet's displayed weight without converting the band captions puts a 19.1 kg dog on a
 * screen under a column headed "21-40 lb", and an operator reading that cannot tell whether the
 * weight is wrong, the tier is wrong, or the salon is charging the wrong band. So the assertions
 * that matter most here are the ones tying the captions to the same bounds the pricing comparison
 * uses, and the one proving the unit cannot move a price.
 */
describe("weight units", () => {
  it("recognises exactly the two units the column allows", () => {
    expect([...weightUnits]).toEqual(["lb", "kg"]);
    expect(isWeightUnit("lb")).toBe(true);
    expect(isWeightUnit("kg")).toBe(true);
    // Uppercase is refused because the stored value is what arrives; 'LB' would fail the check
    // constraint in 0047 at the database rather than at the schema.
    expect(isWeightUnit("LB")).toBe(false);
    expect(isWeightUnit("stone")).toBe(false);
    expect(isWeightUnit("")).toBe(false);
  });
});

describe("weight conversion", () => {
  it("converts from the canonical stored ounces", () => {
    expect(weightFromOunces(672, "lb")).toBe(42);
    // One ounce is 28.349523125 grams by definition, so 672 oz is 19.05 kg. The assertion is on
    // the exact definition rather than a rounded constant, because a converter built on 2.2 or
    // 0.4536 drifts by tens of grams at the top of the range.
    expect(weightFromOunces(672, "kg")).toBeCloseTo(19.0509, 4);
    expect(weightFromOunces(null, "kg")).toBeNull();
    expect(weightFromOunces(undefined, "lb")).toBeNull();
  });

  it("round-trips a typed weight back to within half an ounce", () => {
    // The column is an integer of ounces, so a round trip can lose at most half of one. That is
    // the honest bound and it holds in both units.
    for (const unit of weightUnits) {
      for (const entered of [0.5, 3.5, 20, 42.25, 100]) {
        const ounces = ouncesFromWeight(entered, unit)!;
        expect(Number.isInteger(ounces), `${entered} ${unit}`).toBe(true);
        expect(Math.abs(weightFromOunces(ounces, unit)! - entered), `${entered} ${unit}`)
          .toBeLessThanOrEqual(0.5 / (unit === "lb" ? 16 : 1000 / 28.349523125));
      }
    }
  });

  it("refuses a negative or unparseable entry rather than storing one", () => {
    // `pets.weight_ounces` carries `check (weight_ounces is null or weight_ounces >= 0)` since
    // 0001. Returning null here means "no weight recorded", which the column already allows.
    expect(ouncesFromWeight(-5, "lb")).toBeNull();
    expect(ouncesFromWeight(Number.NaN, "kg")).toBeNull();
    expect(ouncesFromWeight(null, "lb")).toBeNull();
  });

  it("writes a single weight with its unit", () => {
    expect(formatWeight(672, "lb")).toBe("42 lb");
    expect(formatWeight(56, "lb")).toBe("3.5 lb");
    expect(formatWeight(672, "kg")).toBe("19.1 kg");
    expect(formatWeight(null, "lb")).toBeNull();
  });
});

describe("weight tier captions", () => {
  it("reproduces the pound captions the tiers have always carried", () => {
    // THE LOAD-BEARING ASSERTION. `weightTiers[].label` is the caption the product has shown since
    // the tiers were defined, and `weightTierLabel` is now the only thing that generates one. If
    // the derivation and the constant ever disagree, the bounds a price is resolved by and the
    // caption an operator reads have drifted apart - which is the whole failure this design
    // prevents - and this fails character for character rather than approximately.
    for (const tier of weightTiers) {
      expect(weightTierLabel(tier, "lb"), tier.code).toBe(tier.label);
    }
    expect(weightTiers.map((tier) => weightTierLabel(tier, "lb"))).toEqual([
      "1–20 lb", "21–40 lb", "41–60 lb", "61–80 lb", "81–100 lb", "100+ lb"
    ]);
  });

  it("converts every band when the unit does", () => {
    // Not round numbers, and correct rather than sloppy: the pricing boundary genuinely falls at
    // 320 ounces, which is genuinely 9.07 kg. Rounding the caption to a tidy 9 or 10 kg would
    // describe a boundary the pricing does not have.
    expect(weightTiers.map((tier) => weightTierLabel(tier, "kg"))).toEqual([
      "0.1–9.1 kg", "9.2–18.1 kg", "18.2–27.2 kg", "27.3–36.3 kg", "36.4–45.4 kg", "45.4+ kg"
    ]);
  });

  it("leaves no gap between one band's top and the next band's bottom", () => {
    // A caption set with a hole in it would let an operator conclude a weight has no band. The
    // printed bands must be contiguous at the display step: one pound, or one tenth of a kilogram.
    for (const unit of weightUnits) {
      const step = unit === "lb" ? 1 : 0.1;
      const captions = weightTiers.map((tier) => weightTierLabel(tier, unit));
      for (let index = 1; index < captions.length - 1; index += 1) {
        const previousTop = Number(captions[index - 1]!.split("–")[1]!.replace(` ${unit}`, ""));
        const thisBottom = Number(captions[index]!.split("–")[0]!);
        expect(Number((thisBottom - previousTop).toFixed(2)), `${unit} ${index}`)
          .toBeCloseTo(step, 5);
      }
    }
  });

  it("publishes one caption per tier code, in tier order", () => {
    const published = weightTierLabels(weightTiers, "kg");
    expect(published.map((entry) => entry.code)).toEqual(weightTiers.map((tier) => tier.code));
    expect(published[0]!.label).toBe("0.1–9.1 kg");
  });
});

describe("the unit cannot move a price", () => {
  const tiers = weightTiers.map((tier, index) => ({
    pricingClass: "STANDARD" as const, weightTierCode: tier.code, priceMinor: 4000 + index * 500
  }));
  const resolve = (weightOunces: number, weightUnit: "lb" | "kg") => resolveTierPrice({
    pricingMode: "TIERED", basePriceMinor: 0, pricingClass: "STANDARD", weightOunces, tiers, weightUnit
  });

  it("charges the same amount and the same tier whatever the salon reads", () => {
    // The property that makes `weightUnit` safe to be a presentation setting. Ounces are the
    // comparison; the unit only decides the caption. A salon may switch it twice a day and no
    // client's price moves.
    for (const ounces of [1, 320, 321, 640, 960, 1280, 1600, 1601, 5000]) {
      const pounds = resolve(ounces, "lb");
      const kilograms = resolve(ounces, "kg");
      expect(pounds.status, String(ounces)).toBe("resolved");
      if (pounds.status !== "resolved" || kilograms.status !== "resolved") throw new Error("unreachable");
      expect(kilograms.priceMinor, String(ounces)).toBe(pounds.priceMinor);
      expect(kilograms.weightTierCode, String(ounces)).toBe(pounds.weightTierCode);
      expect(kilograms.source, String(ounces)).toBe(pounds.source);
      // And the one thing that DOES move is the caption.
      expect(kilograms.weightTierLabel).not.toBe(pounds.weightTierLabel);
      expect(kilograms.weightTierLabel).toContain("kg");
      expect(pounds.weightTierLabel).toContain("lb");
    }
  });

  it("captions the tier the pet actually resolved into", () => {
    // The mismatch this whole design exists to prevent: the caption returned beside a price must
    // be the caption of the band the ounce comparison chose, not of a neighbouring one.
    for (const ounces of [1, 320, 321, 960, 1601]) {
      const tier = resolveWeightTier(ounces)!;
      const resolved = resolve(ounces, "kg");
      if (resolved.status !== "resolved") throw new Error("unreachable");
      expect(resolved.weightTierLabel, String(ounces)).toBe(weightTierLabel(tier, "kg"));
    }
  });

  it("defaults to pounds for a caller that names no unit", () => {
    // Every existing caller, including the mobile app, keeps the captions it already renders.
    const resolved = resolveTierPrice({
      pricingMode: "TIERED", basePriceMinor: 0, pricingClass: "STANDARD", weightOunces: 672, tiers
    });
    if (resolved.status !== "resolved") throw new Error("unreachable");
    expect(resolved.weightTierLabel).toBe("41–60 lb");
  });

  it("still refuses to price a pet with no weight", () => {
    // Unchanged behaviour, asserted because the unit work touched this function.
    for (const unit of weightUnits) {
      expect(resolveTierPrice({
        pricingMode: "TIERED", basePriceMinor: 0, pricingClass: "STANDARD",
        weightOunces: null, tiers, weightUnit: unit
      }).status).toBe("weight_required");
    }
  });
});
