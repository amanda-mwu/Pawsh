import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {createApp} from "../../src/app.js";import {createDatabase,type Database} from "../../src/db/client.js";import type {Config} from "../../src/config.js";
const databaseUrl=process.env.DATABASE_URL;const describeDatabase=databaseUrl?describe:describe.skip;
const config:Config={NODE_ENV:"test",DOCUMENT_STORAGE_ADAPTER:"memory",PORT:3000,DATABASE_URL:databaseUrl??"postgres://unavailable",SESSION_SECRET:"service-pricing-test-secret-at-least-32-chars",APP_ORIGIN:"http://localhost:3000",SMTP_PORT:587,SMTP_SECURE:false};
function cookie(response:{headers:Record<string,unknown>}){return String(response.headers["set-cookie"]).split(";",1)[0]!;}
describeDatabase("tenant service pricing and breed catalog",()=>{let db:Database;let app:Awaited<ReturnType<typeof createApp>>;let ownerCookie:string;let businessId:string;let locationId:string;let customerId:string;let employeeId:string;let bathId:string;let groomId:string;const suffix=crypto.randomUUID();
 beforeAll(async()=>{db=createDatabase(config);app=await createApp(config,db,{runWorker:false,serveStatic:false});await app.ready();const signup=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:`pricing-${suffix}@example.test`,password:"correct horse pricing battery",businessName:"Pricing Test"}});ownerCookie=cookie(signup);({businessId,locationId}=signup.json());const customer=await app.inject({method:"POST",url:"/api/customers",headers:{cookie:ownerCookie},payload:{firstName:"Price",lastName:"Tester"}});customerId=customer.json().id;const services=await app.inject({method:"GET",url:"/api/services",headers:{cookie:ownerCookie}});bathId=services.json().find((service:{seedKey:string})=>service.seedKey==="dog-bath-brush").id;groomId=services.json().find((service:{seedKey:string})=>service.seedKey==="dog-groom-style").id;const employee=await app.inject({method:"POST",url:"/api/employees",headers:{cookie:ownerCookie},payload:{displayName:"Tier Groomer",serviceIds:[bathId,groomId]}});employeeId=employee.json().id;});afterAll(async()=>{await app.close();await db.end();});
  // Breeds are canonical Pawsh taxonomy now, not a per-tenant catalog. A salon configures its
  // own pricing class and availability against a shared breed; it cannot rename or invent one.
  it("serves the canonical dog taxonomy and scopes breeds to their pet type",async()=>{
    const types=await app.inject({method:"GET",url:"/api/pet-types",headers:{cookie:ownerCookie}});
    expect(types.statusCode).toBe(200);
    const dog=types.json().find((type:{search:string})=>type.search==="dog");
    const cat=types.json().find((type:{search:string})=>type.search==="cat");
    expect(dog&&cat).toBeTruthy();
    const dogBreedList=await app.inject({method:"GET",url:`/api/pet-types/${dog.id}/breeds`,headers:{cookie:ownerCookie}});
    const names=dogBreedList.json().map((breed:{name:string})=>breed.name);
    // The approved canonical wording, not the legacy "German Shepherd Dog".
    expect(names).toContain("German Shepherd");
    expect(names).not.toContain("German Shepherd Dog");
    expect(names).toContain("American Pit Bull Terrier");
    const catBreedList=await app.inject({method:"GET",url:`/api/pet-types/${cat.id}/breeds`,headers:{cookie:ownerCookie}});
    const catNames=catBreedList.json().map((breed:{name:string})=>breed.name);
    expect(catNames).toContain("Persian");
    expect(catNames).not.toContain("Poodle");
    // The legacy path still resolves, and now serves the same canonical rows.
    const legacy=await app.inject({method:"GET",url:"/api/dog-breeds",headers:{cookie:ownerCookie}});
    expect(legacy.json().map((breed:{name:string})=>breed.name)).toContain("German Shepherd");
  });

  it("records a salon pricing override without touching the shared taxonomy",async()=>{
    const breeds=(await app.inject({method:"GET",url:"/api/dog-breeds",headers:{cookie:ownerCookie}})).json();
    const beagle=breeds.find((breed:{name:string})=>breed.name==="Beagle");
    expect(beagle).toMatchObject({defaultPricingClass:"STANDARD",customized:false});
    const saved=await app.inject({method:"PUT",url:`/api/breeds/${beagle.id}/settings`,headers:{cookie:ownerCookie},payload:{pricingClass:"EXTRA_FLOOF"}});
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({name:"Beagle",defaultPricingClass:"EXTRA_FLOOF",customized:true});
    // The canonical row is untouched: the override belongs to this tenant alone.
    const [canonical]=await db<{defaultPricingClass:string}[]>`select default_pricing_class from breeds where id=${beagle.id}`;
    expect(canonical!.defaultPricingClass).toBe("STANDARD");
    const other=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:`breed-tenant-${suffix}@example.test`,password:"correct horse breed tenant",businessName:"Breed Tenant"}});
    const theirs=(await app.inject({method:"GET",url:"/api/dog-breeds",headers:{cookie:cookie(other)}})).json();
    expect(theirs.find((breed:{name:string})=>breed.name==="Beagle").defaultPricingClass).toBe("STANDARD");
    // Clearing both fields restores the Pawsh default rather than freezing today's value.
    const cleared=await app.inject({method:"PUT",url:`/api/breeds/${beagle.id}/settings`,headers:{cookie:ownerCookie},payload:{pricingClass:null,active:null}});
    expect(cleared.json()).toMatchObject({defaultPricingClass:"STANDARD",customized:false});
  });

  it("refuses unknown breed text but grandfathers a legacy pet through an unrelated edit",async()=>{
    const rejected=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},payload:{customerId,name:"Typo Pet",species:"dog",breed:"Golden Retreiver"}});
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe("BREED_NOT_IN_CATALOG");
    // A SEARCH_ALIAS helps a human find a breed; it must not rewrite stored data.
    const searchAlias=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},payload:{customerId,name:"Nickname Pet",species:"dog",breed:"GSD"}});
    expect(searchAlias.statusCode).toBe(400);
    // A SAFE_EXACT_ALIAS does resolve, onto the canonical breed.
    const safeAlias=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},payload:{customerId,name:"Alias Pet",species:"dog",breed:"German Shepherd Dog"}});
    expect(safeAlias.statusCode).toBe(201);
    expect(safeAlias.json().breed).toBe("German Shepherd");
    // Explicit Other is the deliberate escape hatch.
    const other=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},payload:{customerId,name:"Mix Pet",species:"dog",breedOther:"Sheepadoodle mix"}});
    expect(other.statusCode).toBe(201);
    expect(other.json()).toMatchObject({breedId:null,breedOther:"Sheepadoodle mix",breed:"Sheepadoodle mix"});
    // A pre-existing row whose breed predates the taxonomy stays editable.
    const [legacyPet]=await db<{id:string;version:number}[]>`insert into pets(business_id,customer_id,name,species,breed) values (${businessId},${customerId},'Legacy Pet','dog','Historic Village Dog') returning id,version`;
    const edited=await app.inject({method:"PUT",url:`/api/pets/${legacyPet!.id}`,headers:{cookie:ownerCookie},payload:{customerId,name:"Legacy Pet",species:"dog",breed:"Historic Village Dog",weightOunces:400,version:legacyPet!.version}});
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({breed:"Historic Village Dog",breedId:null,weightOunces:400});
  });
 it("resolves breed prices and does not guess missing weight",async()=>{for(const [name,breed,weight,serviceId,expected] of [["Box","Boxer",720,bathId,7500],["Gold","Goldendoodle",720,groomId,14500],["Missing","Unknown",null,bathId,null]] as const){const pet=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},payload:{customerId,name,species:"dog",breed,weightOunces:weight}});const response=await app.inject({method:"POST",url:"/api/pricing/resolve",headers:{cookie:ownerCookie},payload:{petId:pet.json().id,serviceIds:[serviceId]}});expect(response.statusCode).toBe(200);expect(response.json()[0].priceMinor).toBe(expected);if(expected===null)expect(response.json()[0].status).toBe("weight_required");}});
 it("snapshots server price across later edits",async()=>{const pet=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},payload:{customerId,name:"Snapshot",species:"dog",breed:"Boxer",weightOunces:720}});const appointment=await app.inject({method:"POST",url:"/api/appointments",headers:{cookie:ownerCookie,"idempotency-key":crypto.randomUUID()},payload:{locationId,customerId,petId:pet.json().id,employeeId,serviceIds:[bathId],localStart:"2034-04-20T09:00",expectedLocationVersion:1,priceMinor:1}});expect(appointment.statusCode).toBe(201);await app.inject({method:"PUT",url:`/api/services/${bathId}/pricing`,headers:{cookie:ownerCookie},payload:{prices:[{pricingClass:"SMOOTH_SINGLE",weightTierCode:"TIER_3",priceMinor:9999}]}});const [snapshot]=await db<{price:number;pricingClass:string;weightTier:string}[]>`select price_minor_snapshot price,pricing_class_snapshot pricing_class,weight_tier_snapshot weight_tier from appointment_services where business_id=${businessId} and appointment_id=${appointment.json().id}`;expect(snapshot).toEqual({price:7500,pricingClass:"SMOOTH_SINGLE",weightTier:"TIER_3"});});

  // The composite foreign key is what makes "a Cat cannot be a Golden Retriever" a database
  // fact rather than a convention. The dev database holds two such legacy rows; they survive
  // because they carry no breed_id, not because the rule is lax.
  it("refuses a breed that does not belong to the pet's type",async()=>{
    const types=(await app.inject({method:"GET",url:"/api/pet-types",headers:{cookie:ownerCookie}})).json();
    const dog=types.find((type:{search:string})=>type.search==="dog");
    const cat=types.find((type:{search:string})=>type.search==="cat");
    const dogBreeds=(await app.inject({method:"GET",url:`/api/pet-types/${dog.id}/breeds`,headers:{cookie:ownerCookie}})).json();
    const poodle=dogBreeds.find((breed:{name:string})=>breed.name==="Poodle");

    const mismatched=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},
      payload:{customerId,name:"Confused Pet",species:"cat",petTypeId:cat.id,breedId:poodle.id}});
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().code).toBe("BREED_NOT_IN_CATALOG");

    const matched=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},
      payload:{customerId,name:"Correct Pet",species:"dog",petTypeId:dog.id,breedId:poodle.id}});
    expect(matched.statusCode).toBe(201);
    expect(matched.json()).toMatchObject({breedId:poodle.id,breed:"Poodle"});

    // The database refuses the same mismatch even when the API is bypassed entirely.
    await expect(db`update pets set breed_id=${poodle.id} where id=${matched.json().id} and business_id=${businessId} and pet_type_id=${cat.id}`)
      .resolves.toBeDefined();
    await expect(db`update pets set pet_type_id=${cat.id} where id=${matched.json().id} and business_id=${businessId}`)
      .rejects.toThrow();

    // A breed this salon has switched off cannot be assigned to a new pet.
    await app.inject({method:"PUT",url:`/api/breeds/${poodle.id}/settings`,headers:{cookie:ownerCookie},payload:{active:false}});
    const deactivated=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},
      payload:{customerId,name:"Blocked Pet",species:"dog",petTypeId:dog.id,breedId:poodle.id}});
    expect(deactivated.statusCode).toBe(400);
    // An inactive breed prices at the neutral default rather than recovering its class by name.
    const priced=await app.inject({method:"POST",url:"/api/pricing/resolve",headers:{cookie:ownerCookie},
      payload:{petId:matched.json().id,serviceIds:[groomId]}});
    expect(priced.json()[0].pricingClass).toBe("STANDARD");
    await app.inject({method:"PUT",url:`/api/breeds/${poodle.id}/settings`,headers:{cookie:ownerCookie},payload:{pricingClass:null,active:null}});
  });


  // Two reviewed taxonomy outcomes that must not drift back.
  //
  // "Sheep Dog" is retired because the name is ambiguous, NOT folded into Old English Sheepdog:
  // that fold would move EXTRA_FLOOF -> STANDARD, a price cut dressed up as a cleanup.
  it("retires Sheep Dog without repointing it at another breed",async()=>{
    const [sheepDog]=await db<{active:boolean;defaultPricingClass:string}[]>`
      select active,default_pricing_class from breeds where normalized_name='sheep dog'`;
    expect(sheepDog).toMatchObject({active:false});
    // No alias may resolve the retired name onto anything.
    const [aliased]=await db<{count:number}[]>`
      select count(*)::int as count from breed_aliases where normalized_name='sheep dog'`;
    expect(aliased!.count).toBe(0);
    // Old English Sheepdog is untouched and keeps its own class.
    const [oes]=await db<{active:boolean;defaultPricingClass:string}[]>`
      select active,default_pricing_class from breeds where normalized_name='old english sheepdog'`;
    expect(oes).toMatchObject({active:true,defaultPricingClass:"STANDARD"});
  });

  // Irish Water Dog and Irish Water Spaniel are one animal. The Spaniel survives as canonical at
  // EXTRA_FLOOF - the coat class it should always have carried - and the Dog spelling becomes a
  // safe exact alias onto it, so the fold cannot move a price.
  it("consolidates Irish Water Dog onto the Irish Water Spaniel",async()=>{
    const [spaniel]=await db<{id:string;active:boolean;defaultPricingClass:string}[]>`
      select id,active,default_pricing_class from breeds where normalized_name='irish water spaniel'`;
    expect(spaniel).toMatchObject({active:true,defaultPricingClass:"EXTRA_FLOOF"});
    const [dog]=await db<{active:boolean}[]>`
      select active from breeds where normalized_name='irish water dog'`;
    expect(dog).toMatchObject({active:false});
    const [alias]=await db<{breedId:string;aliasKind:string}[]>`
      select breed_id,alias_kind from breed_aliases where normalized_name='irish water dog'`;
    expect(alias).toMatchObject({breedId:spaniel!.id,aliasKind:"SAFE_EXACT_ALIAS"});

    // The retired spelling is no longer selectable...
    const types=(await app.inject({method:"GET",url:"/api/pet-types",headers:{cookie:ownerCookie}})).json();
    const dogType=types.find((type:{search:string})=>type.search==="dog");
    const selectable=(await app.inject({method:"GET",url:`/api/pet-types/${dogType.id}/breeds`,
      headers:{cookie:ownerCookie}})).json().filter((breed:{active:boolean})=>breed.active)
      .map((breed:{name:string})=>breed.name);
    expect(selectable).not.toContain("Irish Water Dog");
    expect(selectable).not.toContain("Sheep Dog");
    expect(selectable).toContain("Irish Water Spaniel");

    // ...but the alias still resolves legacy text onto the surviving canonical breed.
    const created=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},
      payload:{customerId,name:"Water Pet",species:"dog",breed:"Irish Water Dog"}});
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({breedId:spaniel!.id,breed:"Irish Water Spaniel"});
  });

  // An explicit Other is a finished answer, not a half-resolved record: it carries no canonical
  // id, keeps its description, and prices at the neutral default.
  it("prices an explicit Other at the default and leaves it editable",async()=>{
    const created=await app.inject({method:"POST",url:"/api/pets",headers:{cookie:ownerCookie},
      payload:{customerId,name:"Other Pet",species:"dog",breedOther:"Pomeranian x Chihuahua"}});
    expect(created.statusCode).toBe(201);
    const petId=created.json().id;
    const [stored]=await db<{breedId:string|null;breedOther:string|null;breed:string|null}[]>`
      select breed_id,breed_other,breed from pets where id=${petId}`;
    expect(stored).toMatchObject({breedId:null,breedOther:"Pomeranian x Chihuahua"});
    const priced=await app.inject({method:"POST",url:"/api/pricing/resolve",headers:{cookie:ownerCookie},
      payload:{petId,serviceIds:[groomId]}});
    expect(priced.json()[0].pricingClass).toBe("STANDARD");
    // An unrelated edit must not force a breed decision.
    const edited=await app.inject({method:"PUT",url:`/api/pets/${petId}`,headers:{cookie:ownerCookie},
      payload:{customerId,name:"Other Pet",species:"dog",breedOther:"Pomeranian x Chihuahua",weightOunces:320,version:created.json().version}});
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({breedId:null,breedOther:"Pomeranian x Chihuahua",weightOunces:320});
  });

});
