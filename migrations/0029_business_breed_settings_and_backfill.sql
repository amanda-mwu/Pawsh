begin;

-- ---------------------------------------------------------------------------
-- Phase D/E/F: sparse tenant overrides, and the pet backfill onto canonical breeds.
--
-- `business_breeds` held 1,020,258 rows across 4,130 businesses to express 359 distinct
-- names, and an audit found ZERO rows deviating from the Pawsh seed class and ZERO
-- deactivated. So this table starts empty and is expected to stay tiny: it records only
-- the places a salon DISAGREES with the shared taxonomy, never the taxonomy itself.
--
-- Recreating a full business x breed catalog here would rebuild the million-row duplication
-- this migration exists to remove.
-- ---------------------------------------------------------------------------
create table business_breed_settings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  breed_id uuid not null references breeds(id),

  -- Both nullable: null means "no opinion, inherit the canonical default". A row must carry
  -- at least one opinion, or it is noise that would slow every lookup for nothing.
  pricing_class text
    check (pricing_class is null or pricing_class in ('SMOOTH_SINGLE','STANDARD','EXTRA_FLOOF')),
  active boolean,

  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (business_id, id),
  unique (business_id, breed_id),
  constraint business_breed_setting_has_an_opinion
    check (pricing_class is not null or active is not null)
);

create index business_breed_setting_lookup on business_breed_settings (business_id, breed_id);

alter table business_breed_settings enable row level security;
create policy tenant_isolation on business_breed_settings
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Phase E: pets adopt the canonical relationship.
--
-- Pet type first, because the composite foreign key will not accept a breed until the pet's
-- type agrees with it. `species` is free text that has drifted ('dog', 'Dog', 'Cat'), so the
-- match is on the normalized value rather than the raw string.
-- ---------------------------------------------------------------------------
update pets set pet_type_id = pet_type.id
from pet_types pet_type
where pets.pet_type_id is null
  and pet_type.normalized_name = lower(btrim(pets.species));

-- Exact canonical match, scoped to the pet's own type. No fuzzy matching, no cross-type
-- guessing: a name that does not match exactly stays unresolved and keeps its legacy text.
update pets set breed_id = breed.id
from breeds breed
where pets.breed_id is null
  and pets.pet_type_id is not null
  and breed.pet_type_id = pets.pet_type_id
  and breed.active
  and breed.normalized_name = regexp_replace(
        regexp_replace(lower(btrim(pets.breed)), '[\s\-_]+', ' ', 'g'),
        '[^a-z0-9 ]', '', 'g');

-- Then SAFE_EXACT_ALIAS only. A SEARCH_ALIAS helps a human find a breed and must never
-- silently rewrite stored data, so it is deliberately excluded here.
update pets set breed_id = alias.breed_id
from breed_aliases alias
where pets.breed_id is null
  and pets.pet_type_id is not null
  and alias.pet_type_id = pets.pet_type_id
  and alias.alias_kind = 'SAFE_EXACT_ALIAS'
  and alias.normalized_name = regexp_replace(
        regexp_replace(lower(btrim(pets.breed)), '[\s\-_]+', ' ', 'g'),
        '[^a-z0-9 ]', '', 'g');

-- ---------------------------------------------------------------------------
-- Phase F: carry across the only thing in `business_breeds` that is genuinely a tenant
-- decision - a pricing class that disagrees with the canonical default, or a breed the
-- salon switched off.
--
-- Matched by normalized name within the Dog taxonomy, because that is the only pet type
-- the legacy table ever described. A legacy row whose name is not in the canonical taxonomy
-- (a salon-invented breed) has nowhere to go and is reported rather than guessed at; pets
-- carrying such a name keep their legacy text and resolve to the default class, exactly as
-- they do today.
-- ---------------------------------------------------------------------------
insert into business_breed_settings (business_id, breed_id, pricing_class, active)
select legacy.business_id, breed.id,
  case when legacy.default_pricing_class is distinct from breed.default_pricing_class
    then legacy.default_pricing_class end,
  case when legacy.active is false then false end
from business_breeds legacy
join pet_types pet_type on pet_type.normalized_name = 'dog'
join breeds breed on breed.pet_type_id = pet_type.id
  and breed.normalized_name = legacy.normalized_name
where legacy.default_pricing_class is distinct from breed.default_pricing_class
   or legacy.active is false
on conflict (business_id, breed_id) do nothing;

insert into schema_migrations(version) values ('0029_business_breed_settings_and_backfill');
commit;
