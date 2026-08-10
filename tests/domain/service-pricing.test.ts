import {describe,expect,it} from "vitest";
import {resolveTierPrice,resolveWeightTier,type PriceTier,type PricingClass} from "../../src/domain/pricing.js";
import {defaultBreedPricingClass,defaultServices} from "../../src/domain/catalog-seed.js";
const codes=["TIER_1","TIER_2","TIER_3","TIER_4","TIER_5","TIER_6"] as const;
function prices(key:string,pricingClass:PricingClass):PriceTier[]{const service=defaultServices.find(item=>item.key===key);const values=service?.prices?.[pricingClass];if(!Array.isArray(values))throw new Error("Missing seed matrix");return values.map((priceMinor,index)=>({pricingClass,weightTierCode:codes[index]!,priceMinor}));}
function matrix(key:string,pricingClass:PricingClass){return [16,336,656,976,1296,1616].map(weightOunces=>resolveTierPrice({pricingMode:"TIERED",basePriceMinor:0,pricingClass,weightOunces,tiers:prices(key,pricingClass)})).map(result=>result.status==="resolved"?result.priceMinor:null);}
describe("service tier pricing",()=>{
 it("matches every Pawssentials dog matrix",()=>{expect(matrix("dog-bath-brush","SMOOTH_SINGLE")).toEqual([5500,6500,7500,8500,9500,10500]);expect(matrix("dog-bath-brush","STANDARD")).toEqual([6000,7000,8000,9000,10000,11000]);expect(matrix("dog-groom-style","STANDARD")).toEqual([9000,10000,11000,12000,13000,14000]);expect(matrix("dog-groom-style","EXTRA_FLOOF")).toEqual([11500,13000,14500,16000,17500,19000]);});
 it("uses inclusive upper boundaries and requires positive weight",()=>{expect([320,321,640,960,1280,1600,1601].map(value=>resolveWeightTier(value)?.code)).toEqual(["TIER_1","TIER_2","TIER_2","TIER_3","TIER_4","TIER_5","TIER_6"]);expect(resolveWeightTier(null)).toBeNull();expect(resolveWeightTier(0)).toBeNull();});
 it("maps breed defaults without inferring weight",()=>{expect(defaultBreedPricingClass("Boxer")).toBe("SMOOTH_SINGLE");expect(defaultBreedPricingClass("Goldendoodle")).toBe("EXTRA_FLOOF");expect(defaultBreedPricingClass("Unknown")).toBe("STANDARD");});
});
