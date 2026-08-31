import type postgres from "postgres";
import type {PricingClass,WeightTierCode} from "@pawsh/domain";

type Sql=postgres.Sql|postgres.TransactionSql;
const smooth=new Set(["Boston Terrier","Boxer","Dalmatian","Doberman Pinscher","French Bulldog","Great Dane","Greyhound","Weimaraner"]);
const floof=new Set(["Aussiedoodle","Barbet","Bichonpoo","Bernedoodle","Bouvier des Flandres","Cavapoo","Cockapoo","French Water Dog","Goldendoodle","Irish Doodle","Irish Water Dog","Labradoodle","Lagotto","Lagotto Romagnolo","Poodle","Newfoundland","Newfoundland Dog","Newfypoo","Pomapoo","Portuguese Water Dog","Samoyed","Schnoodle","Sheep Dog","Sheepadoodle","Spanish Water Dog","Soft Coated Wheaten Terrier","Wheaten Terrier","Whoodle"]);
export function defaultBreedPricingClass(name:string):PricingClass{return smooth.has(name)?"SMOOTH_SINGLE":floof.has(name)?"EXTRA_FLOOF":"STANDARD";}

type SeedService={key:string;name:string;category:string;mode:string;base:number;duration?:number;rangeMax?:number;confirmation?:boolean;prices?:Partial<Record<PricingClass|WeightTierCode,number[]|number>>};
const bathSmooth=[5500,6500,7500,8500,9500,10500];
const bathStandard=[6000,7000,8000,9000,10000,11000];
const groomStandard=[9000,10000,11000,12000,13000,14000];
const groomFloof=[11500,13000,14500,16000,17500,19000];
export const defaultServices:readonly SeedService[]=[
 {key:"dog-bath-brush",name:"Bath + Brush",category:"DOG_BASE",mode:"TIERED",base:6000,prices:{SMOOTH_SINGLE:bathSmooth,STANDARD:bathStandard}},
 {key:"dog-bath-tidy",name:"Bath + Tidy",category:"DOG_BASE",mode:"TIERED",base:8000,prices:{SMOOTH_SINGLE:bathSmooth.map(v=>v+2000),STANDARD:bathStandard.map(v=>v+2000),EXTRA_FLOOF:bathStandard.map(v=>v+3000)}},
 {key:"dog-groom-style",name:"Groom + Style",category:"DOG_BASE",mode:"TIERED",base:9000,prices:{STANDARD:groomStandard,EXTRA_FLOOF:groomFloof}},
 {key:"spawssentials",name:"SPAWSSENTIALS",category:"DOG_ADDON",mode:"FIXED",base:2000},
 ...[["cloud-coat","Cloud Coat",2500],["flea-tick","Flea + Tick",2500],["mud-bath","Mud Bath",2500],["de-skunk","De-Skunk",3000]].map(([key,name,base])=>({key:String(key),name:String(name),category:"DOG_ADDON",mode:"FIXED",base:Number(base)})),
 {key:"shed-less",name:"Shed-Less",category:"DOG_ADDON",mode:"WEIGHT_TIER",base:2000,prices:{TIER_1:2000,TIER_2:2000,TIER_3:3000,TIER_4:3000,TIER_5:3000,TIER_6:3000}},
 {key:"zoom-bath",name:"Zoom Service Bath",category:"DOG_ADDON",mode:"SERVICE_TYPE_FIXED",base:2000},
 {key:"zoom-groom",name:"Zoom Service Groom",category:"DOG_ADDON",mode:"SERVICE_TYPE_FIXED",base:3000},
 ...[["specialty-cut","Specialty/Breed Cut",3000],["paw-soak","Paw Soak",1500],["nail-polish","Nail Polish",2000]].map(([key,name,base])=>({key:String(key),name:String(name),category:"DOG_ADDON",mode:"FIXED",base:Number(base)})),
 {key:"creative-color",name:"Creative Color Hair Dye",category:"DOG_ADDON",mode:"QUOTE_REQUIRED",base:0},
 ...[["nail-trim-buff","Nail Trim + Buff",2000,15],["ear-cleaning","Ear Cleaning",1000,10],["ear-plucking","Ear Plucking",1000,10],["teeth-brushing","Teeth Brushing",1000,10],["gland-expression","Gland Expression",1000,10],["paw-balm","Paw Balm",1000,10],["pawdicure","Pawdicure",4000,30],["face-trim","Face Trim",1500,15],["eye-visor-trim","Eye/Visor Trim",1000,10],["feet-trim","Feet Trim",1000,10],["sanitary-trim","Sanitary Trim",1000,10],["rear-feather-trim","Rear Feather Trim",1500,15],["tail-trim","Tail Trim",1000,10],["poodle-face","Poodle Face",1500,15],["poodle-feet","Poodle Feet",2000,20]].map(([key,name,base,duration])=>({key:String(key),name:String(name),category:"A_LA_CARTE",mode:"FIXED",base:Number(base),duration:Number(duration)})),
 {key:"cat-bath-brush",name:"Cat Bath + Brush",category:"CAT",mode:"RANGE",base:11000,rangeMax:12000,confirmation:true},
 {key:"cat-groom-style",name:"Cat Groom + Style",category:"CAT",mode:"FIXED",base:17000},
 ...[["cat-shed-less","Cat Shed-Less",2500],["cat-flea-tick","Cat Flea + Tick",2500],["cat-deep-clean","Cat Deep Clean + Degrease",2500],["cat-nail-trim","Cat Nail Trim",3000],["cat-sanitary","Cat Sanitary",2500],["cat-feet-trim","Cat Feet Trim",2500]].map(([key,name,base])=>({key:String(key),name:String(name),category:"CAT",mode:"FIXED",base:Number(base)}))
];

// Breeds are no longer seeded per business. They are a single global taxonomy in `breeds`,
// established by migration 0028; a new salon inherits it without copying 247 rows, and records
// only its disagreements in `business_breed_settings`. The static `dogBreeds` list survives
// solely as the source that migration was generated from.
export async function provisionBusinessCatalog(sql:Sql,businessId:string):Promise<void>{
 const services=defaultServices.map(service=>({business_id:businessId,name:service.name,description:"Pawsh default; duration requires salon review",base_duration_minutes:service.duration??60,base_price_minor:service.base,category:service.category,pricing_mode:service.mode,seed_key:service.key,range_max_minor:service.rangeMax??null,price_confirmation_required:service.confirmation??false}));
 await sql`insert into services ${sql(services,"business_id","name","description","base_duration_minutes","base_price_minor","category","pricing_mode","seed_key","range_max_minor","price_confirmation_required")} on conflict (business_id,seed_key) where seed_key is not null do nothing`;
 const rows=await sql<{id:string;seedKey:string}[]>`select id,seed_key from services where business_id=${businessId} and seed_key is not null`;
 const ids=new Map(rows.map(row=>[row.seedKey,row.id]));
 const prices:{business_id:string;service_id:string;pricing_class:string;weight_tier_code:string;price_minor:number}[]=[];
 for(const service of defaultServices){const id=ids.get(service.key);if(!id||!service.prices)continue;for(const [dimension,value] of Object.entries(service.prices)){if(Array.isArray(value))for(let i=0;i<value.length;i++)prices.push({business_id:businessId,service_id:id,pricing_class:dimension,weight_tier_code:`TIER_${i+1}`,price_minor:value[i]!});else prices.push({business_id:businessId,service_id:id,pricing_class:"STANDARD",weight_tier_code:dimension,price_minor:value});}}
 if(prices.length)await sql`insert into service_price_tiers ${sql(prices,"business_id","service_id","pricing_class","weight_tier_code","price_minor")} on conflict (service_id,pricing_class,weight_tier_code) do nothing`;
 await provisionTaxAndPaymentSettings(sql,businessId);
}

/**
 * The tax and payment configuration a salon starts with.
 *
 * Migration 0034 gave every business that already existed the four settlement types as built-in
 * payment methods and its current tax rate as the rate in force. A business created afterwards
 * has to arrive the same way, or its first visit to Settings -> Tax & Payment would show a blank
 * screen implying it charges no tax and takes no payments - while checkout happily records both.
 *
 * Idempotent, so re-running the provisioner over an existing business adds nothing.
 */
export async function provisionTaxAndPaymentSettings(sql:Sql,businessId:string):Promise<void>{
 const methods=[
  {name:"Cash",settlement_type:"cash",sort_order:10},
  {name:"Card",settlement_type:"external_card",sort_order:20},
  {name:"Check",settlement_type:"check",sort_order:30},
  {name:"Other",settlement_type:"other",sort_order:40}
 ].map(method=>({business_id:businessId,...method,enabled:true,built_in:true}));
 await sql`insert into payment_methods ${sql(methods,"business_id","name","settlement_type","sort_order","enabled","built_in")} on conflict do nothing`;
 // Named after the rate the business is already charging, exactly as the backfill named it, and
 // inserted only when nothing is in force - never as a second default.
 await sql`
  insert into tax_rates (business_id,name,rate_basis_points,is_default)
  select business.id,
   case when business.tax_rate_basis_points=0 then 'No tax' else 'Sales tax' end,
   business.tax_rate_basis_points,true
  from businesses business
  where business.id=${businessId}
   and not exists (select 1 from tax_rates rate where rate.business_id=business.id)
  on conflict do nothing
 `;
}
