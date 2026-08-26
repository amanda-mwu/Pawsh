import type postgres from "postgres";
import {normalizeBreedSearch} from "@pawsh/domain";
import {resolveTierPrice,type PricingClass,type PriceTier} from "@pawsh/domain";

type Sql=postgres.Sql|postgres.TransactionSql;
export interface ResolvedServicePrice {
  serviceId:string;name:string;category:string;pricingMode:string;durationMinutes:number;
  status:"resolved"|"weight_required"|"quote_required"|"confirmation_required";
  pricingClass:PricingClass;weightTierCode:string|null;weightTierLabel:string|null;
  priceMinor:number|null;resolutionSource:string;
}

export async function resolveServicePrices(sql:Sql,input:{businessId:string;petId:string;serviceIds:readonly string[]}):Promise<ResolvedServicePrice[]>{
 const [pet]=await sql<{weightOunces:number|null;breed:string|null;species:string}[]>`select weight_ounces,breed,species from pets where business_id=${input.businessId} and id=${input.petId} and archived_at is null`;
 if(!pet)throw Object.assign(new Error("Pet not found"),{statusCode:404});
 const [breed]=pet.breed?await sql<{defaultPricingClass:PricingClass}[]>`select default_pricing_class from business_breeds where business_id=${input.businessId} and normalized_name=${normalizeBreedSearch(pet.breed)} limit 1`:[];
 const petClass:PricingClass=breed?.defaultPricingClass??"STANDARD";
 const services=await sql<{id:string;name:string;category:string;pricingMode:string;basePriceMinor:number;baseDurationMinutes:number;rangeMaxMinor:number|null;priceConfirmationRequired:boolean}[]>`select id,name,category,pricing_mode,base_price_minor,base_duration_minutes,range_max_minor,price_confirmation_required from services where business_id=${input.businessId} and id in ${sql(input.serviceIds as string[])} and active`;
 if(services.length!==new Set(input.serviceIds).size)throw Object.assign(new Error("One or more services are unavailable"),{statusCode:400});
 const output:ResolvedServicePrice[]=[];
 for(const service of services){
  const tiers=await sql<(PriceTier&{durationMinutes:number|null})[]>`select pricing_class,weight_tier_code,price_minor,duration_minutes from service_price_tiers where business_id=${input.businessId} and service_id=${service.id} and active`;
  const exact=resolveTierPrice({pricingMode:service.pricingMode,basePriceMinor:service.basePriceMinor,pricingClass:petClass,weightOunces:pet.weightOunces,tiers});
  let result=exact;
  let resolvedClass=petClass;
  if(exact.status==="confirmation_required" && service.pricingMode==="TIERED" && petClass!=="STANDARD"){
    result=resolveTierPrice({pricingMode:service.pricingMode,basePriceMinor:service.basePriceMinor,pricingClass:"STANDARD",weightOunces:pet.weightOunces,tiers});resolvedClass="STANDARD";
  }
  if(result.status!=="resolved"){output.push({serviceId:service.id,name:service.name,category:service.category,pricingMode:service.pricingMode,durationMinutes:service.baseDurationMinutes,status:result.status,pricingClass:resolvedClass,weightTierCode:null,weightTierLabel:null,priceMinor:null,resolutionSource:result.status});continue;}
  const duration=tiers.find(t=>t.pricingClass===resolvedClass&&t.weightTierCode===result.weightTierCode)?.durationMinutes??service.baseDurationMinutes;
  output.push({serviceId:service.id,name:service.name,category:service.category,pricingMode:service.pricingMode,durationMinutes:duration,status:"resolved",pricingClass:resolvedClass,weightTierCode:result.weightTierCode,weightTierLabel:result.weightTierLabel,priceMinor:result.priceMinor,resolutionSource:result.source});
 }
 return input.serviceIds.map(id=>output.find(item=>item.serviceId===id)!);
}
