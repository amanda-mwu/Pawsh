import type postgres from "postgres";
import {isWeightUnit,resolveTierPrice,type PricingClass,type PriceTier,type WeightUnit} from "@pawsh/domain";

type Sql=postgres.Sql|postgres.TransactionSql;
export interface ResolvedServicePrice {
  serviceId:string;name:string;category:string;pricingMode:string;durationMinutes:number;
  status:"resolved"|"weight_required"|"quote_required"|"confirmation_required";
  pricingClass:PricingClass;weightTierCode:string|null;weightTierLabel:string|null;
  priceMinor:number|null;resolutionSource:string;
}

export async function resolveServicePrices(sql:Sql,input:{businessId:string;petId:string;serviceIds:readonly string[]}):Promise<ResolvedServicePrice[]>{
 // The workspace's weight unit rides along on the pet lookup rather than costing a second round
 // trip. It changes NOTHING about which tier the pet lands in - that is `resolveWeightTier`
 // comparing integer ounces, whatever the salon reads - and only decides how the returned
 // `weightTierLabel` is captioned. A salon on kilograms must not be shown its pet's weight in
 // kilograms beside a band captioned in pounds; see `weight.ts`.
 const [pet]=await sql<{weightOunces:number|null;breed:string|null;breedId:string|null;species:string;weightUnit:string|null}[]>`
   select weight_ounces,breed,breed_id,species,
     (select business.weight_unit from businesses business where business.id=${input.businessId}) as weight_unit
   from pets where business_id=${input.businessId} and id=${input.petId} and archived_at is null`;
 if(!pet)throw Object.assign(new Error("Pet not found"),{statusCode:404});
 const weightUnit:WeightUnit=isWeightUnit(pet.weightUnit??"")?pet.weightUnit as WeightUnit:"lb";
 // Coat class resolves through the canonical breed ID, never through `pets.breed` text.
 //
 // The old lookup matched the stored name against this tenant's `business_breeds` rows. That
 // made a Settings rename silently reprice the salon's book, and it missed near-misses outright
 // - 3,084 pets stored as "German Shepherd" never matched the catalog's "German Shepherd Dog"
 // and quietly fell back to STANDARD. Identity is now the ID, so a display-name correction
 // cannot move a price.
 //
 // Precedence: the tenant's sparse override, then the canonical default, then STANDARD. An
 // INACTIVE breed deliberately yields STANDARD rather than falling back to the legacy name,
 // because recovering the class through the name would defeat deactivating it. Legacy pets with
 // no `breed_id` resolve to STANDARD, which is exactly what the name lookup already gave them.
 //
 // A business-owned breed (`breeds.business_id` non-null) resolves through exactly the same join:
 // its class lives on its own row, and the account's sparse override still layers on top. The
 // tenant predicate keeps another account's breed from ever answering here - a pet can only carry
 // such an id through a database the API never wrote, and this refuses to price it rather than
 // reading a class the tenant does not own.
 const [breedClass]=pet.breedId?await sql<{pricingClass:PricingClass|null}[]>`
   select case when coalesce(override.active,breed.active)
               then coalesce(override.pricing_class,breed.default_pricing_class) end as pricing_class
   from breeds breed
   left join business_breed_settings override
     on override.business_id=${input.businessId} and override.breed_id=breed.id
   where breed.id=${pet.breedId}
     and (breed.business_id is null or breed.business_id=${input.businessId})`:[];
 const petClass:PricingClass=breedClass?.pricingClass??"STANDARD";
 const services=await sql<{id:string;name:string;category:string;pricingMode:string;basePriceMinor:number;baseDurationMinutes:number;rangeMaxMinor:number|null;priceConfirmationRequired:boolean}[]>`select id,name,category,pricing_mode,base_price_minor,base_duration_minutes,range_max_minor,price_confirmation_required from services where business_id=${input.businessId} and id in ${sql(input.serviceIds as string[])} and active`;
 if(services.length!==new Set(input.serviceIds).size)throw Object.assign(new Error("One or more services are unavailable"),{statusCode:400});
 const output:ResolvedServicePrice[]=[];
 for(const service of services){
  const tiers=await sql<(PriceTier&{durationMinutes:number|null})[]>`select pricing_class,weight_tier_code,price_minor,duration_minutes from service_price_tiers where business_id=${input.businessId} and service_id=${service.id} and active`;
  const exact=resolveTierPrice({pricingMode:service.pricingMode,basePriceMinor:service.basePriceMinor,pricingClass:petClass,weightOunces:pet.weightOunces,tiers,weightUnit});
  let result=exact;
  let resolvedClass=petClass;
  if(exact.status==="confirmation_required" && service.pricingMode==="TIERED" && petClass!=="STANDARD"){
    result=resolveTierPrice({pricingMode:service.pricingMode,basePriceMinor:service.basePriceMinor,pricingClass:"STANDARD",weightOunces:pet.weightOunces,tiers,weightUnit});resolvedClass="STANDARD";
  }
  if(result.status!=="resolved"){output.push({serviceId:service.id,name:service.name,category:service.category,pricingMode:service.pricingMode,durationMinutes:service.baseDurationMinutes,status:result.status,pricingClass:resolvedClass,weightTierCode:null,weightTierLabel:null,priceMinor:null,resolutionSource:result.status});continue;}
  const duration=tiers.find(t=>t.pricingClass===resolvedClass&&t.weightTierCode===result.weightTierCode)?.durationMinutes??service.baseDurationMinutes;
  output.push({serviceId:service.id,name:service.name,category:service.category,pricingMode:service.pricingMode,durationMinutes:duration,status:"resolved",pricingClass:resolvedClass,weightTierCode:result.weightTierCode,weightTierLabel:result.weightTierLabel,priceMinor:result.priceMinor,resolutionSource:result.source});
 }
 return input.serviceIds.map(id=>output.find(item=>item.serviceId===id)!);
}
