import {weightTierLabel,type WeightUnit} from "./weight.js";

export const pricingClasses = ["SMOOTH_SINGLE","STANDARD","EXTRA_FLOOF"] as const;
export type PricingClass = typeof pricingClasses[number];

/**
 * The six weight bands every tiered price is resolved through.
 *
 * `minExclusiveOunces` and `maxOunces` are the authority: they are what `resolveWeightTier`
 * compares a pet against, and `pets.weight_ounces` is the canonical stored unit. The bands were
 * CHOSEN in pounds - 320, 640, 960, 1280 and 1600 ounces are 20, 40, 60, 80 and 100 lb - which is
 * why `label` reads the way it does.
 *
 * `label` is the POUND caption and stays here so that nothing which already reads it changes
 * meaning. It is no longer the only caption: a workspace set to kilograms must see these same
 * boundaries expressed in kilograms, or an operator reads a 19.1 kg dog against a band captioned
 * "21-40 lb" and cannot tell which of the two is lying. `weightTierLabel` in `weight.ts` derives
 * the caption from the bounds for either unit, and `weight.test.ts` asserts it reproduces every
 * `label` here character for character - so the bounds and their captions cannot drift apart.
 */
export const weightTiers = [
  {code:"TIER_1",label:"1–20 lb",minExclusiveOunces:0,maxOunces:320},
  {code:"TIER_2",label:"21–40 lb",minExclusiveOunces:320,maxOunces:640},
  {code:"TIER_3",label:"41–60 lb",minExclusiveOunces:640,maxOunces:960},
  {code:"TIER_4",label:"61–80 lb",minExclusiveOunces:960,maxOunces:1280},
  {code:"TIER_5",label:"81–100 lb",minExclusiveOunces:1280,maxOunces:1600},
  {code:"TIER_6",label:"100+ lb",minExclusiveOunces:1600,maxOunces:null}
] as const;
export type WeightTierCode = typeof weightTiers[number]["code"];

export function resolveWeightTier(weightOunces:number|null):typeof weightTiers[number]|null {
  if(weightOunces===null || !Number.isInteger(weightOunces) || weightOunces<=0)return null;
  return weightTiers.find(tier=>weightOunces>tier.minExclusiveOunces && (tier.maxOunces===null || weightOunces<=tier.maxOunces))??null;
}

export interface PriceTier {pricingClass:PricingClass|null;weightTierCode:WeightTierCode|null;priceMinor:number}

/**
 * Resolves a service's price for one pet.
 *
 * `weightUnit` affects the returned `weightTierLabel` AND NOTHING ELSE. Which tier a pet falls in,
 * and therefore what it is charged, is decided by `resolveWeightTier` comparing integer ounces -
 * the same comparison whatever the workspace displays. Defaulting to `"lb"` keeps every existing
 * caller, including the mobile app, on the captions it already renders.
 */
export function resolveTierPrice(input:{pricingMode:string;basePriceMinor:number;pricingClass:PricingClass;weightOunces:number|null;tiers:readonly PriceTier[];weightUnit?:WeightUnit}):
  {status:"resolved";priceMinor:number;pricingClass:PricingClass;weightTierCode:WeightTierCode|null;weightTierLabel:string|null;source:string}|
  {status:"weight_required"|"quote_required"|"confirmation_required"} {
  if(input.pricingMode==="QUOTE_REQUIRED")return {status:"quote_required"};
  if(input.pricingMode==="RANGE")return {status:"confirmation_required"};
  if(input.pricingMode==="FIXED" || input.pricingMode==="SERVICE_TYPE_FIXED")return {status:"resolved",priceMinor:input.basePriceMinor,pricingClass:input.pricingClass,weightTierCode:null,weightTierLabel:null,source:"fixed"};
  const tier=resolveWeightTier(input.weightOunces);
  if(!tier)return {status:"weight_required"};
  const price=input.tiers.find(item=>item.weightTierCode===tier.code && (input.pricingMode==="WEIGHT_TIER" || item.pricingClass===input.pricingClass));
  if(!price)return {status:"confirmation_required"};
  return {status:"resolved",priceMinor:price.priceMinor,pricingClass:input.pricingClass,weightTierCode:tier.code,weightTierLabel:weightTierLabel(tier,input.weightUnit??"lb"),source:input.pricingMode==="WEIGHT_TIER"?"weight_tier":"breed_default"};
}
