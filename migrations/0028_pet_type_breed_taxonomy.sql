begin;

-- ---------------------------------------------------------------------------
-- Pet Type -> canonical Breed taxonomy (Phases A-C, additive only).
--
-- Pawsh's breed identity moves from per-tenant `business_breeds` to a single global
-- taxonomy. The old table currently holds 1,020,258 rows across 4,130 businesses to express
-- 359 distinct breed names, and an audit found ZERO rows deviating from the Pawsh seed
-- default and ZERO deactivated - it is duplication, not tenant configuration.
--
-- Nothing here switches pricing authority. `business_breeds` keeps feeding the resolver
-- until an equivalence run proves the new chain matches it pet for pet. These tables are
-- additive and unread by the application on the pass that introduces them.
--
-- Breed identity is the ID. Display names may be corrected without repricing anything,
-- which is the whole reason the legacy name-based join is being retired.
-- ---------------------------------------------------------------------------

-- Global taxonomy: no `business_id`, so the tenant_isolation policy pattern does not apply.
-- Every authenticated tenant reads the same rows; only the sparse per-business override table
-- (Phase D, not in this migration) is tenant-scoped.
create table pet_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null unique,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table breeds (
  id uuid primary key default gen_random_uuid(),
  pet_type_id uuid not null references pet_types(id),
  name text not null,
  normalized_name text not null,
  -- Pawsh's DEFAULT coat/pricing class, not an intrinsic property of the animal. A salon that
  -- disagrees records a sparse override; it does not edit the shared taxonomy.
  default_pricing_class text not null default 'STANDARD'
    check (default_pricing_class in ('SMOOTH_SINGLE','STANDARD','EXTRA_FLOOF')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Scoped to the pet type, never global: a cat Persian and a dog Persian must be able to
  -- coexist. This is exactly the constraint `business_breeds` could not express.
  unique (pet_type_id, normalized_name),
  -- Lets `pets` prove breed-belongs-to-pet-type with a composite foreign key.
  unique (pet_type_id, id)
);

create index breed_lookup on breeds (pet_type_id, active, name);

-- Alternate spellings resolving to one canonical breed.
--
-- `alias_kind` decides whether an alias may rewrite data:
--   SAFE_EXACT_ALIAS  unambiguous, and verified to carry the same default pricing class as its
--                     canonical. Only these may be used by a backfill.
--   SEARCH_ALIAS      helps a human find the breed. Never rewrites stored data.
--   AMBIGUOUS         recorded for review; resolves nothing automatically.
-- An alias never carries a pricing class. Pricing resolves through the canonical breed ID only.
create table breed_aliases (
  id uuid primary key default gen_random_uuid(),
  pet_type_id uuid not null,
  breed_id uuid not null,
  name text not null,
  normalized_name text not null,
  alias_kind text not null default 'SEARCH_ALIAS'
    check (alias_kind in ('SAFE_EXACT_ALIAS','SEARCH_ALIAS','AMBIGUOUS')),
  created_at timestamptz not null default now(),
  -- An alias can never point at a breed belonging to a different pet type.
  foreign key (pet_type_id, breed_id) references breeds(pet_type_id, id) on delete cascade,
  -- One meaning per spelling per pet type. A name that is already canonical cannot also be an
  -- alias, because the seed below excludes those.
  unique (pet_type_id, normalized_name)
);

create index breed_alias_resolution on breed_aliases (pet_type_id, alias_kind, normalized_name);

insert into pet_types (name, normalized_name, sort_order) values
  ('Dog', 'dog', 1),
  ('Cat', 'cat', 2);

insert into breeds (pet_type_id, name, normalized_name, default_pricing_class)
select pet_type.id, seed.name, seed.normalized_name, seed.pricing_class
from pet_types pet_type
join (values
  ('dog','Affenpinscher','affenpinscher','STANDARD'),
  ('dog','Afghan Hound','afghan hound','STANDARD'),
  ('dog','Airedale Terrier','airedale terrier','STANDARD'),
  ('dog','Akita','akita','STANDARD'),
  ('dog','Alaskan Malamute','alaskan malamute','STANDARD'),
  ('dog','American Bulldog','american bulldog','STANDARD'),
  ('dog','American English Coonhound','american english coonhound','STANDARD'),
  ('dog','American Eskimo Dog','american eskimo dog','STANDARD'),
  ('dog','American Foxhound','american foxhound','STANDARD'),
  ('dog','American Hairless Terrier','american hairless terrier','STANDARD'),
  ('dog','American Leopard Hound','american leopard hound','STANDARD'),
  ('dog','American Staffordshire Terrier','american staffordshire terrier','STANDARD'),
  ('dog','American Water Spaniel','american water spaniel','STANDARD'),
  ('dog','Appenzeller Sennenhund','appenzeller sennenhund','STANDARD'),
  ('dog','Australian Cattle Dog','australian cattle dog','STANDARD'),
  ('dog','Australian Kelpie','australian kelpie','STANDARD'),
  ('dog','Australian Shepherd','australian shepherd','STANDARD'),
  ('dog','Australian Terrier','australian terrier','STANDARD'),
  ('dog','Azawakh','azawakh','STANDARD'),
  ('dog','Barbet','barbet','EXTRA_FLOOF'),
  ('dog','Basenji','basenji','STANDARD'),
  ('dog','Basset Hound','basset hound','STANDARD'),
  ('dog','Beagle','beagle','STANDARD'),
  ('dog','Bearded Collie','bearded collie','STANDARD'),
  ('dog','Beauceron','beauceron','STANDARD'),
  ('dog','Bedlington Terrier','bedlington terrier','STANDARD'),
  ('dog','Belgian Laekenois','belgian laekenois','STANDARD'),
  ('dog','Belgian Malinois','belgian malinois','STANDARD'),
  ('dog','Belgian Sheepdog','belgian sheepdog','STANDARD'),
  ('dog','Belgian Tervuren','belgian tervuren','STANDARD'),
  ('dog','Bergamasco Sheepdog','bergamasco sheepdog','STANDARD'),
  ('dog','Berger Picard','berger picard','STANDARD'),
  ('dog','Bernese Mountain Dog','bernese mountain dog','STANDARD'),
  ('dog','Bichon Frise','bichon frise','STANDARD'),
  ('dog','Biewer Terrier','biewer terrier','STANDARD'),
  ('dog','Black and Tan Coonhound','black and tan coonhound','STANDARD'),
  ('dog','Black Russian Terrier','black russian terrier','STANDARD'),
  ('dog','Bloodhound','bloodhound','STANDARD'),
  ('dog','Bluetick Coonhound','bluetick coonhound','STANDARD'),
  ('dog','Boerboel','boerboel','STANDARD'),
  ('dog','Bohemian Shepherd','bohemian shepherd','STANDARD'),
  ('dog','Bolognese','bolognese','STANDARD'),
  ('dog','Border Collie','border collie','STANDARD'),
  ('dog','Border Terrier','border terrier','STANDARD'),
  ('dog','Borzoi','borzoi','STANDARD'),
  ('dog','Boston Terrier','boston terrier','SMOOTH_SINGLE'),
  ('dog','Bouvier des Flandres','bouvier des flandres','EXTRA_FLOOF'),
  ('dog','Boxer','boxer','SMOOTH_SINGLE'),
  ('dog','Boykin Spaniel','boykin spaniel','STANDARD'),
  ('dog','Bracco Italiano','bracco italiano','STANDARD'),
  ('dog','Braque du Bourbonnais','braque du bourbonnais','STANDARD'),
  ('dog','Briard','briard','STANDARD'),
  ('dog','Brittany','brittany','STANDARD'),
  ('dog','Brussels Griffon','brussels griffon','STANDARD'),
  ('dog','Bull Terrier','bull terrier','STANDARD'),
  ('dog','Bullmastiff','bullmastiff','STANDARD'),
  ('dog','Cairn Terrier','cairn terrier','STANDARD'),
  ('dog','Canaan Dog','canaan dog','STANDARD'),
  ('dog','Cane Corso','cane corso','STANDARD'),
  ('dog','Cardigan Welsh Corgi','cardigan welsh corgi','STANDARD'),
  ('dog','Carolina Dog','carolina dog','STANDARD'),
  ('dog','Catahoula Leopard Dog','catahoula leopard dog','STANDARD'),
  ('dog','Cavalier King Charles Spaniel','cavalier king charles spaniel','STANDARD'),
  ('dog','Cesky Terrier','cesky terrier','STANDARD'),
  ('dog','Chesapeake Bay Retriever','chesapeake bay retriever','STANDARD'),
  ('dog','Chihuahua','chihuahua','STANDARD'),
  ('dog','Chinese Crested','chinese crested','STANDARD'),
  ('dog','Chinese Shar-Pei','chinese shar pei','STANDARD'),
  ('dog','Chinook','chinook','STANDARD'),
  ('dog','Chow Chow','chow chow','STANDARD'),
  ('dog','Clumber Spaniel','clumber spaniel','STANDARD'),
  ('dog','Cocker Spaniel','cocker spaniel','STANDARD'),
  ('dog','Collie','collie','STANDARD'),
  ('dog','Coton de Tulear','coton de tulear','STANDARD'),
  ('dog','Curly-Coated Retriever','curly coated retriever','STANDARD'),
  ('dog','Dachshund','dachshund','STANDARD'),
  ('dog','Dalmatian','dalmatian','SMOOTH_SINGLE'),
  ('dog','Dandie Dinmont Terrier','dandie dinmont terrier','STANDARD'),
  ('dog','Danish-Swedish Farmdog','danish swedish farmdog','STANDARD'),
  ('dog','Doberman Pinscher','doberman pinscher','SMOOTH_SINGLE'),
  ('dog','Dogo Argentino','dogo argentino','STANDARD'),
  ('dog','Dogue de Bordeaux','dogue de bordeaux','STANDARD'),
  ('dog','Dutch Shepherd','dutch shepherd','STANDARD'),
  ('dog','English Cocker Spaniel','english cocker spaniel','STANDARD'),
  ('dog','English Foxhound','english foxhound','STANDARD'),
  ('dog','English Setter','english setter','STANDARD'),
  ('dog','English Springer Spaniel','english springer spaniel','STANDARD'),
  ('dog','English Toy Spaniel','english toy spaniel','STANDARD'),
  ('dog','Entlebucher Mountain Dog','entlebucher mountain dog','STANDARD'),
  ('dog','Estrela Mountain Dog','estrela mountain dog','STANDARD'),
  ('dog','Eurasier','eurasier','STANDARD'),
  ('dog','Field Spaniel','field spaniel','STANDARD'),
  ('dog','Finnish Lapphund','finnish lapphund','STANDARD'),
  ('dog','Finnish Spitz','finnish spitz','STANDARD'),
  ('dog','Flat-Coated Retriever','flat coated retriever','STANDARD'),
  ('dog','French Bulldog','french bulldog','SMOOTH_SINGLE'),
  ('dog','German Pinscher','german pinscher','STANDARD'),
  ('dog','German Shorthaired Pointer','german shorthaired pointer','STANDARD'),
  ('dog','German Spitz','german spitz','STANDARD'),
  ('dog','German Wirehaired Pointer','german wirehaired pointer','STANDARD'),
  ('dog','Giant Schnauzer','giant schnauzer','STANDARD'),
  ('dog','Glen of Imaal Terrier','glen of imaal terrier','STANDARD'),
  ('dog','Golden Retriever','golden retriever','STANDARD'),
  ('dog','Gordon Setter','gordon setter','STANDARD'),
  ('dog','Great Dane','great dane','SMOOTH_SINGLE'),
  ('dog','Great Pyrenees','great pyrenees','STANDARD'),
  ('dog','Greater Swiss Mountain Dog','greater swiss mountain dog','STANDARD'),
  ('dog','Greyhound','greyhound','SMOOTH_SINGLE'),
  ('dog','Harrier','harrier','STANDARD'),
  ('dog','Havanese','havanese','STANDARD'),
  ('dog','Ibizan Hound','ibizan hound','STANDARD'),
  ('dog','Icelandic Sheepdog','icelandic sheepdog','STANDARD'),
  ('dog','Irish Red and White Setter','irish red and white setter','STANDARD'),
  ('dog','Irish Setter','irish setter','STANDARD'),
  ('dog','Irish Terrier','irish terrier','STANDARD'),
  ('dog','Irish Water Spaniel','irish water spaniel','STANDARD'),
  ('dog','Irish Wolfhound','irish wolfhound','STANDARD'),
  ('dog','Italian Greyhound','italian greyhound','STANDARD'),
  ('dog','Japanese Chin','japanese chin','STANDARD'),
  ('dog','Japanese Spitz','japanese spitz','STANDARD'),
  ('dog','Keeshond','keeshond','STANDARD'),
  ('dog','Kerry Blue Terrier','kerry blue terrier','STANDARD'),
  ('dog','Komondor','komondor','STANDARD'),
  ('dog','Korean Jindo Dog','korean jindo dog','STANDARD'),
  ('dog','Kuvasz','kuvasz','STANDARD'),
  ('dog','Labrador Retriever','labrador retriever','STANDARD'),
  ('dog','Lagotto Romagnolo','lagotto romagnolo','EXTRA_FLOOF'),
  ('dog','Lakeland Terrier','lakeland terrier','STANDARD'),
  ('dog','Lancashire Heeler','lancashire heeler','STANDARD'),
  ('dog','Leonberger','leonberger','STANDARD'),
  ('dog','Lhasa Apso','lhasa apso','STANDARD'),
  ('dog','Lowchen','lowchen','STANDARD'),
  ('dog','Maltese','maltese','STANDARD'),
  ('dog','Manchester Terrier','manchester terrier','STANDARD'),
  ('dog','Mastiff','mastiff','STANDARD'),
  ('dog','Miniature American Shepherd','miniature american shepherd','STANDARD'),
  ('dog','Miniature Bull Terrier','miniature bull terrier','STANDARD'),
  ('dog','Miniature Pinscher','miniature pinscher','STANDARD'),
  ('dog','Miniature Schnauzer','miniature schnauzer','STANDARD'),
  ('dog','Mountain Cur','mountain cur','STANDARD'),
  ('dog','Neapolitan Mastiff','neapolitan mastiff','STANDARD'),
  ('dog','Nederlandse Kooikerhondje','nederlandse kooikerhondje','STANDARD'),
  ('dog','Newfoundland','newfoundland','EXTRA_FLOOF'),
  ('dog','Norfolk Terrier','norfolk terrier','STANDARD'),
  ('dog','Norwegian Buhund','norwegian buhund','STANDARD'),
  ('dog','Norwegian Elkhound','norwegian elkhound','STANDARD'),
  ('dog','Norwegian Lundehund','norwegian lundehund','STANDARD'),
  ('dog','Norwich Terrier','norwich terrier','STANDARD'),
  ('dog','Nova Scotia Duck Tolling Retriever','nova scotia duck tolling retriever','STANDARD'),
  ('dog','Old English Sheepdog','old english sheepdog','STANDARD'),
  ('dog','Otterhound','otterhound','STANDARD'),
  ('dog','Papillon','papillon','STANDARD'),
  ('dog','Parson Russell Terrier','parson russell terrier','STANDARD'),
  ('dog','Pekingese','pekingese','STANDARD'),
  ('dog','Pembroke Welsh Corgi','pembroke welsh corgi','STANDARD'),
  ('dog','Peruvian Inca Orchid','peruvian inca orchid','STANDARD'),
  ('dog','Petit Basset Griffon Vendeen','petit basset griffon vendeen','STANDARD'),
  ('dog','Pharaoh Hound','pharaoh hound','STANDARD'),
  ('dog','Plott Hound','plott hound','STANDARD'),
  ('dog','Pointer','pointer','STANDARD'),
  ('dog','Polish Lowland Sheepdog','polish lowland sheepdog','STANDARD'),
  ('dog','Pomeranian','pomeranian','STANDARD'),
  ('dog','Poodle','poodle','EXTRA_FLOOF'),
  ('dog','Portuguese Podengo Pequeno','portuguese podengo pequeno','STANDARD'),
  ('dog','Portuguese Pointer','portuguese pointer','STANDARD'),
  ('dog','Portuguese Water Dog','portuguese water dog','EXTRA_FLOOF'),
  ('dog','Presa Canario','presa canario','STANDARD'),
  ('dog','Pug','pug','STANDARD'),
  ('dog','Puli','puli','STANDARD'),
  ('dog','Pumi','pumi','STANDARD'),
  ('dog','Pyrenean Mastiff','pyrenean mastiff','STANDARD'),
  ('dog','Pyrenean Shepherd','pyrenean shepherd','STANDARD'),
  ('dog','Rat Terrier','rat terrier','STANDARD'),
  ('dog','Redbone Coonhound','redbone coonhound','STANDARD'),
  ('dog','Rhodesian Ridgeback','rhodesian ridgeback','STANDARD'),
  ('dog','Rottweiler','rottweiler','STANDARD'),
  ('dog','Russell Terrier','russell terrier','STANDARD'),
  ('dog','Russian Toy','russian toy','STANDARD'),
  ('dog','Saint Bernard','saint bernard','STANDARD'),
  ('dog','Saluki','saluki','STANDARD'),
  ('dog','Samoyed','samoyed','EXTRA_FLOOF'),
  ('dog','Schipperke','schipperke','STANDARD'),
  ('dog','Scottish Deerhound','scottish deerhound','STANDARD'),
  ('dog','Scottish Terrier','scottish terrier','STANDARD'),
  ('dog','Sealyham Terrier','sealyham terrier','STANDARD'),
  ('dog','Shetland Sheepdog','shetland sheepdog','STANDARD'),
  ('dog','Shiba Inu','shiba inu','STANDARD'),
  ('dog','Shih Tzu','shih tzu','STANDARD'),
  ('dog','Siberian Husky','siberian husky','STANDARD'),
  ('dog','Silky Terrier','silky terrier','STANDARD'),
  ('dog','Skye Terrier','skye terrier','STANDARD'),
  ('dog','Sloughi','sloughi','STANDARD'),
  ('dog','Small Munsterlander','small munsterlander','STANDARD'),
  ('dog','Spanish Mastiff','spanish mastiff','STANDARD'),
  ('dog','Spinone Italiano','spinone italiano','STANDARD'),
  ('dog','Staffordshire Bull Terrier','staffordshire bull terrier','STANDARD'),
  ('dog','Standard Schnauzer','standard schnauzer','STANDARD'),
  ('dog','Sussex Spaniel','sussex spaniel','STANDARD'),
  ('dog','Swedish Vallhund','swedish vallhund','STANDARD'),
  ('dog','Thai Ridgeback','thai ridgeback','STANDARD'),
  ('dog','Tibetan Mastiff','tibetan mastiff','STANDARD'),
  ('dog','Tibetan Spaniel','tibetan spaniel','STANDARD'),
  ('dog','Tibetan Terrier','tibetan terrier','STANDARD'),
  ('dog','Toy Fox Terrier','toy fox terrier','STANDARD'),
  ('dog','Treeing Walker Coonhound','treeing walker coonhound','STANDARD'),
  ('dog','Vizsla','vizsla','STANDARD'),
  ('dog','Weimaraner','weimaraner','SMOOTH_SINGLE'),
  ('dog','Welsh Springer Spaniel','welsh springer spaniel','STANDARD'),
  ('dog','Welsh Terrier','welsh terrier','STANDARD'),
  ('dog','West Highland White Terrier','west highland white terrier','STANDARD'),
  ('dog','Whippet','whippet','STANDARD'),
  ('dog','Wire Fox Terrier','wire fox terrier','STANDARD'),
  ('dog','Wirehaired Pointing Griffon','wirehaired pointing griffon','STANDARD'),
  ('dog','Wirehaired Vizsla','wirehaired vizsla','STANDARD'),
  ('dog','Xoloitzcuintli','xoloitzcuintli','STANDARD'),
  ('dog','Yorkshire Terrier','yorkshire terrier','STANDARD'),
  ('dog','Cockapoo','cockapoo','EXTRA_FLOOF'),
  ('dog','Goldendoodle','goldendoodle','EXTRA_FLOOF'),
  ('dog','Labradoodle','labradoodle','EXTRA_FLOOF'),
  ('dog','Maltipoo','maltipoo','STANDARD'),
  ('dog','Pomsky','pomsky','STANDARD'),
  ('dog','Schnoodle','schnoodle','EXTRA_FLOOF'),
  ('dog','Aussiedoodle','aussiedoodle','EXTRA_FLOOF'),
  ('dog','Bernedoodle','bernedoodle','EXTRA_FLOOF'),
  ('dog','Bichonpoo','bichonpoo','EXTRA_FLOOF'),
  ('dog','Cavapoo','cavapoo','EXTRA_FLOOF'),
  ('dog','Irish Doodle','irish doodle','EXTRA_FLOOF'),
  ('dog','Irish Water Dog','irish water dog','EXTRA_FLOOF'),
  ('dog','Newfypoo','newfypoo','EXTRA_FLOOF'),
  ('dog','Pomapoo','pomapoo','EXTRA_FLOOF'),
  ('dog','Sheep Dog','sheep dog','EXTRA_FLOOF'),
  ('dog','Sheepadoodle','sheepadoodle','EXTRA_FLOOF'),
  ('dog','Spanish Water Dog','spanish water dog','EXTRA_FLOOF'),
  ('dog','Wheaten Terrier','wheaten terrier','EXTRA_FLOOF'),
  ('dog','Whoodle','whoodle','EXTRA_FLOOF'),
  ('dog','Mixed Breed','mixed breed','STANDARD'),
  ('dog','Unknown','unknown','STANDARD'),
  ('dog','Other','other','STANDARD'),
  ('dog','German Shepherd','german shepherd','STANDARD'),
  ('dog','Anatolian Shepherd','anatolian shepherd','STANDARD'),
  ('dog','Caucasian Shepherd','caucasian shepherd','STANDARD'),
  ('dog','Central Asian Shepherd','central asian shepherd','STANDARD'),
  ('dog','English Bulldog','english bulldog','STANDARD'),
  ('dog','American Pit Bull Terrier','american pit bull terrier','STANDARD'),
  ('cat','Abyssinian','abyssinian','STANDARD'),
  ('cat','American Shorthair','american shorthair','STANDARD'),
  ('cat','Balinese','balinese','STANDARD'),
  ('cat','Bengal','bengal','STANDARD'),
  ('cat','Birman','birman','STANDARD'),
  ('cat','British Shorthair','british shorthair','STANDARD'),
  ('cat','Burmese','burmese','STANDARD'),
  ('cat','Cornish Rex','cornish rex','STANDARD'),
  ('cat','Devon Rex','devon rex','STANDARD'),
  ('cat','Domestic Longhair','domestic longhair','STANDARD'),
  ('cat','Domestic Medium Hair','domestic medium hair','STANDARD'),
  ('cat','Domestic Shorthair','domestic shorthair','STANDARD'),
  ('cat','Exotic Shorthair','exotic shorthair','STANDARD'),
  ('cat','Himalayan','himalayan','STANDARD'),
  ('cat','Maine Coon','maine coon','STANDARD'),
  ('cat','Manx','manx','STANDARD'),
  ('cat','Norwegian Forest Cat','norwegian forest cat','STANDARD'),
  ('cat','Oriental Shorthair','oriental shorthair','STANDARD'),
  ('cat','Persian','persian','STANDARD'),
  ('cat','Ragdoll','ragdoll','STANDARD'),
  ('cat','Russian Blue','russian blue','STANDARD'),
  ('cat','Scottish Fold','scottish fold','STANDARD'),
  ('cat','Siamese','siamese','STANDARD'),
  ('cat','Siberian','siberian','STANDARD'),
  ('cat','Sphynx','sphynx','STANDARD'),
  ('cat','Turkish Angora','turkish angora','STANDARD'),
  ('cat','Mixed Breed','mixed breed','STANDARD'),
  ('cat','Unknown','unknown','STANDARD'),
  ('cat','Other','other','STANDARD')
) as seed(pet_type, name, normalized_name, pricing_class)
  on seed.pet_type = pet_type.normalized_name;

insert into breed_aliases (pet_type_id, breed_id, name, normalized_name, alias_kind)
select breed.pet_type_id, breed.id, seed.name, seed.normalized_name, seed.alias_kind
from (values
  ('dog','german shepherd','German Shepherd Dog','german shepherd dog','SAFE_EXACT_ALIAS'),
  ('dog','anatolian shepherd','Anatolian Shepherd Dog','anatolian shepherd dog','SAFE_EXACT_ALIAS'),
  ('dog','caucasian shepherd','Caucasian Shepherd Dog','caucasian shepherd dog','SAFE_EXACT_ALIAS'),
  ('dog','central asian shepherd','Central Asian Shepherd Dog','central asian shepherd dog','SAFE_EXACT_ALIAS'),
  ('dog','english bulldog','Bulldog','bulldog','SAFE_EXACT_ALIAS'),
  ('dog','newfoundland','Newfoundland Dog','newfoundland dog','SAFE_EXACT_ALIAS'),
  ('dog','wheaten terrier','Soft Coated Wheaten Terrier','soft coated wheaten terrier','SAFE_EXACT_ALIAS'),
  ('dog','lagotto romagnolo','Lagotto','lagotto','SAFE_EXACT_ALIAS'),
  ('dog','barbet','French Water Dog','french water dog','SAFE_EXACT_ALIAS'),
  ('dog','german shepherd','GSD','gsd','SEARCH_ALIAS'),
  ('dog','german shepherd','German Shepard','german shepard','SEARCH_ALIAS'),
  ('dog','german shepherd','Alsatian','alsatian','SEARCH_ALIAS'),
  ('dog','american pit bull terrier','Pit Bull','pit bull','SEARCH_ALIAS'),
  ('dog','american pit bull terrier','Pitbull','pitbull','SEARCH_ALIAS'),
  ('dog','yorkshire terrier','Yorkie','yorkie','SEARCH_ALIAS'),
  ('dog','french bulldog','Frenchie','frenchie','SEARCH_ALIAS'),
  ('dog','english bulldog','British Bulldog','british bulldog','SEARCH_ALIAS'),
  ('dog','west highland white terrier','Westie','westie','SEARCH_ALIAS'),
  ('dog','scottish terrier','Scottie','scottie','SEARCH_ALIAS'),
  ('dog','labrador retriever','Lab','lab','SEARCH_ALIAS'),
  ('dog','labrador retriever','Labrador','labrador','SEARCH_ALIAS'),
  ('dog','golden retriever','Golden','golden','SEARCH_ALIAS'),
  ('dog','doberman pinscher','Doberman','doberman','SEARCH_ALIAS'),
  ('dog','doberman pinscher','Dobie','dobie','SEARCH_ALIAS'),
  ('dog','miniature pinscher','Min Pin','min pin','SEARCH_ALIAS'),
  ('dog','rottweiler','Rottie','rottie','SEARCH_ALIAS'),
  ('dog','siberian husky','Husky','husky','SEARCH_ALIAS'),
  ('dog','alaskan malamute','Malamute','malamute','SEARCH_ALIAS'),
  ('dog','australian shepherd','Aussie','aussie','SEARCH_ALIAS'),
  ('dog','australian cattle dog','Blue Heeler','blue heeler','SEARCH_ALIAS'),
  ('dog','australian cattle dog','Red Heeler','red heeler','SEARCH_ALIAS'),
  ('dog','australian cattle dog','Heeler','heeler','SEARCH_ALIAS'),
  ('dog','pembroke welsh corgi','Corgi','corgi','SEARCH_ALIAS'),
  ('dog','pembroke welsh corgi','Pembroke','pembroke','SEARCH_ALIAS'),
  ('dog','bernese mountain dog','Berner','berner','SEARCH_ALIAS'),
  ('dog','newfoundland','Newfie','newfie','SEARCH_ALIAS'),
  ('dog','great pyrenees','Pyr','pyr','SEARCH_ALIAS'),
  ('dog','great pyrenees','Great Pyr','great pyr','SEARCH_ALIAS'),
  ('dog','cavalier king charles spaniel','Cavalier','cavalier','SEARCH_ALIAS'),
  ('dog','cavalier king charles spaniel','Cav','cav','SEARCH_ALIAS'),
  ('dog','english springer spaniel','Springer','springer','SEARCH_ALIAS'),
  ('dog','bichon frise','Bichon','bichon','SEARCH_ALIAS'),
  ('dog','shih tzu','Shitzu','shitzu','SEARCH_ALIAS'),
  ('dog','shih tzu','Shihtzu','shihtzu','SEARCH_ALIAS'),
  ('dog','lhasa apso','Lhasa','lhasa','SEARCH_ALIAS'),
  ('dog','pomeranian','Pom','pom','SEARCH_ALIAS'),
  ('dog','dachshund','Doxie','doxie','SEARCH_ALIAS'),
  ('dog','dachshund','Wiener Dog','wiener dog','SEARCH_ALIAS'),
  ('dog','dachshund','Dachsund','dachsund','SEARCH_ALIAS'),
  ('dog','chinese shar pei','Shar Pei','shar pei','SEARCH_ALIAS'),
  ('dog','chinese shar pei','Sharpei','sharpei','SEARCH_ALIAS'),
  ('dog','chow chow','Chow','chow','SEARCH_ALIAS'),
  ('dog','shiba inu','Shiba','shiba','SEARCH_ALIAS'),
  ('dog','rhodesian ridgeback','Ridgeback','ridgeback','SEARCH_ALIAS'),
  ('dog','old english sheepdog','OES','oes','SEARCH_ALIAS'),
  ('dog','shetland sheepdog','Sheltie','sheltie','SEARCH_ALIAS'),
  ('dog','wheaten terrier','Wheaten','wheaten','SEARCH_ALIAS'),
  ('dog','wheaten terrier','SCWT','scwt','SEARCH_ALIAS'),
  ('dog','russell terrier','Jack Russell','jack russell','SEARCH_ALIAS'),
  ('dog','russell terrier','Jack Russell Terrier','jack russell terrier','SEARCH_ALIAS'),
  ('dog','russell terrier','JRT','jrt','SEARCH_ALIAS'),
  ('dog','coton de tulear','Coton','coton','SEARCH_ALIAS'),
  ('dog','xoloitzcuintli','Xolo','xolo','SEARCH_ALIAS'),
  ('dog','xoloitzcuintli','Mexican Hairless','mexican hairless','SEARCH_ALIAS'),
  ('dog','goldendoodle','Golden Doodle','golden doodle','SEARCH_ALIAS'),
  ('dog','american staffordshire terrier','AmStaff','amstaff','SEARCH_ALIAS'),
  ('dog','staffordshire bull terrier','Staffy','staffy','SEARCH_ALIAS'),
  ('dog','staffordshire bull terrier','Staffie','staffie','SEARCH_ALIAS'),
  ('dog','german shorthaired pointer','GSP','gsp','SEARCH_ALIAS'),
  ('dog','nova scotia duck tolling retriever','Toller','toller','SEARCH_ALIAS'),
  ('dog','portuguese water dog','Portie','portie','SEARCH_ALIAS'),
  ('dog','lagotto romagnolo','Italian Water Dog','italian water dog','SEARCH_ALIAS'),
  ('dog','saint bernard','St Bernard','st bernard','SEARCH_ALIAS'),
  ('dog','lowchen','Little Lion Dog','little lion dog','SEARCH_ALIAS'),
  ('cat','domestic shorthair','DSH','dsh','SEARCH_ALIAS'),
  ('cat','domestic shorthair','Domestic Short Hair','domestic short hair','SEARCH_ALIAS'),
  ('cat','domestic longhair','DLH','dlh','SEARCH_ALIAS'),
  ('cat','domestic longhair','Domestic Long Hair','domestic long hair','SEARCH_ALIAS'),
  ('cat','domestic medium hair','DMH','dmh','SEARCH_ALIAS'),
  ('cat','maine coon','Maine Coon Cat','maine coon cat','SEARCH_ALIAS'),
  ('cat','norwegian forest cat','Norwegian Forest','norwegian forest','SEARCH_ALIAS'),
  ('cat','norwegian forest cat','Wegie','wegie','SEARCH_ALIAS')
) as seed(pet_type, canonical_normalized_name, name, normalized_name, alias_kind)
join pet_types pet_type on pet_type.normalized_name = seed.pet_type
join breeds breed on breed.pet_type_id = pet_type.id
  and breed.normalized_name = seed.canonical_normalized_name;

-- ---------------------------------------------------------------------------
-- Phase C: pets gain the ID relationship. Both columns are nullable and nothing populates
-- them here - the backfill is a separate, reviewed step.
--
-- `species` and `breed` stay exactly as they are. They remain the display/compatibility
-- values every current consumer reads, and a legacy row whose breed was never in any catalog
-- must stay editable for unrelated fields. Requiring taxonomy compliance to save a weight
-- change would strand thousands of records.
-- ---------------------------------------------------------------------------
alter table pets
  add column pet_type_id uuid references pet_types(id),
  add column breed_id uuid,
  -- Free text for a deliberate "Other" selection. Distinct from legacy `breed`: this one is
  -- only ever written when a human explicitly chose Other, so it can be trusted as intent
  -- rather than guessed at.
  add column breed_other text check (breed_other is null or char_length(btrim(breed_other)) between 1 and 120),
  -- The composite reference is what makes "a Cat cannot be a Golden Retriever" a database
  -- fact. The dev database currently holds two such rows; they migrate with breed_id null and
  -- their legacy text intact rather than being rewritten.
  add constraint pet_breed_matches_pet_type
    foreign key (pet_type_id, breed_id) references breeds(pet_type_id, id),
  -- A canonical breed and an explicit Other are mutually exclusive answers to one question.
  add constraint pet_breed_or_other check (breed_id is null or breed_other is null);

create index pet_breed_reference on pets (business_id, breed_id) where breed_id is not null;
create index pet_type_reference on pets (business_id, pet_type_id) where pet_type_id is not null;

insert into schema_migrations(version) values ('0028_pet_type_breed_taxonomy');
commit;
