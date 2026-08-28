begin;

-- ---------------------------------------------------------------------------
-- Reviewed cleanup of legacy pet breed text left unresolved by 0029.
--
-- Both lists below are EXPLICIT ALLOW-LISTS written out by hand. There is no fuzzy matching,
-- no edit distance, and no "obvious" inference: a value resolves because it was reviewed and
-- named here, or it stays exactly as it is.
--
-- Everything not listed keeps `breed_id` null and its legacy text, and stays editable for
-- unrelated fields. That is a valid resting state, not a defect to be cleared.
--
-- PRICE SAFETY. Every unresolved pet currently prices at the default class, because a null
-- `breed_id` resolves to STANDARD. The update below therefore refuses to adopt a canonical
-- breed whose EFFECTIVE class for that pet's business is anything other than STANDARD. The
-- guard is in the WHERE clause rather than in a reviewer's head, so this migration cannot
-- reprice a pet even if a name were added to the list by mistake.
--
-- Deliberately NOT mapped, and not to be added without a product decision:
--   Sheep Dog       -> Old English Sheepdog   EXTRA_FLOOF -> STANDARD
--   Irish Water Dog -> Irish Water Spaniel    EXTRA_FLOOF -> STANDARD
-- Both would move a pet from EXTRA_FLOOF to STANDARD, which is a price cut, not a taxonomy
-- tidy-up. The guard below would refuse them anyway; they are named here so the omission
-- reads as a decision rather than an oversight.
-- ---------------------------------------------------------------------------

-- A. SAFE_CANONICAL: unambiguous, and verified price-neutral by the guard.
update pets
set breed_id = target.breed_id
from (
  select mapping.legacy_normalized, mapping.pet_type, breed.id as breed_id,
    breed.default_pricing_class, breed.active
  from (values
    -- "Yorkie" is universally the Yorkshire Terrier; nothing else in the taxonomy claims it.
    ('yorkie', 'dog', 'yorkshire terrier')
  ) as mapping(legacy_normalized, pet_type, canonical_normalized)
  join pet_types pet_type on pet_type.normalized_name = mapping.pet_type
  join breeds breed on breed.pet_type_id = pet_type.id
    and breed.normalized_name = mapping.canonical_normalized
) as target
where pets.breed_id is null
  and pets.pet_type_id is not null
  and target.active
  and regexp_replace(
        regexp_replace(lower(btrim(pets.breed)), '[\s\-_]+', ' ', 'g'),
        '[^a-z0-9 ]', '', 'g') = target.legacy_normalized
  and exists (
    select 1 from pet_types pet_type
    where pet_type.id = pets.pet_type_id and pet_type.normalized_name = target.pet_type
  )
  -- The effective class this pet would land on must equal what it already resolves to.
  and coalesce((
    select case when coalesce(override.active, target.active)
                then coalesce(override.pricing_class, target.default_pricing_class) end
    from business_breed_settings override
    where override.business_id = pets.business_id and override.breed_id = target.breed_id
  ), case when target.active then target.default_pricing_class end, 'STANDARD') = 'STANDARD';

-- The display mirror follows the canonical name, so the profile stops showing the old wording.
update pets
set breed = breed.name
from breeds breed
where breed.id = pets.breed_id
  and pets.breed is distinct from breed.name;

-- B. OTHER: a real cross that the canonical taxonomy does not carry and should not. Recording
-- it as a deliberate "Other" turns an unresolved leftover into a stated answer, while leaving
-- `breed_id` null so pricing is unchanged.
update pets
set breed_other = btrim(pets.breed)
from (values
  -- Pomeranian x Chihuahua. A designer cross, not a breed the taxonomy should invent a row for.
  ('pomchi')
) as mapping(legacy_normalized)
where pets.breed_id is null
  and pets.breed_other is null
  and regexp_replace(
        regexp_replace(lower(btrim(pets.breed)), '[\s\-_]+', ' ', 'g'),
        '[^a-z0-9 ]', '', 'g') = mapping.legacy_normalized;

insert into schema_migrations(version) values ('0031_resolve_safe_legacy_breeds');
commit;
