begin;

-- ---------------------------------------------------------------------------
-- Two reviewed taxonomy corrections, both established as zero-impact before approval.
--
-- 1. "Sheep Dog" is retired. It is not a breed anyone can select unambiguously - it reads as
--    an Old English Sheepdog, a Border Collie, or an Australian Shepherd depending on who is
--    typing - and a name that invites mis-selection is worse than no name. It is deactivated
--    rather than deleted, and deliberately NOT repointed at Old English Sheepdog: that fold
--    would move a pet from EXTRA_FLOOF to STANDARD, which is a price cut, not a cleanup.
--
-- 2. "Irish Water Dog" and "Irish Water Spaniel" are one breed under two names, split across
--    two rows carrying two different coat classes. The Spaniel's STANDARD was the error: the
--    breed has a dense curly coat much like a Poodle's, and Poodle is EXTRA_FLOOF in the same
--    seed. So the Spaniel is corrected to EXTRA_FLOOF and becomes the canonical row, and the
--    Dog spelling is retired into a SAFE_EXACT_ALIAS pointing at it.
--
-- PRICE SAFETY. Both changes CAN reprice: an inactive breed resolves to the default class, so
-- deactivating one that has pets is a price cut, and raising the Spaniel's class is a price
-- rise. Neither breed has a single pet, override, or appointment reference in the pilot data,
-- which is why this is safe today. The guard below re-proves that at migration time on
-- whatever database it runs against, and REFUSES to proceed rather than silently repricing a
-- salon's book somewhere the assumption does not hold.
-- ---------------------------------------------------------------------------

do $$
declare affected integer;
begin
  select count(*) into affected
  from pets pet
  join breeds breed on breed.id = pet.breed_id
  where breed.normalized_name in ('sheep dog', 'irish water dog', 'irish water spaniel');

  if affected > 0 then
    raise exception using
      message = format(
        'Refusing to retire/reclass water spaniel and sheep dog breeds: %s pet(s) reference them and would be repriced',
        affected),
      hint = 'Decide the pricing outcome for those pets first; this migration assumes zero references.';
  end if;
end $$;

-- Retired, not repointed. Nothing resolves "Sheep Dog" to another breed.
update breeds
set active = false, updated_at = now()
where normalized_name = 'sheep dog'
  and pet_type_id = (select id from pet_types where normalized_name = 'dog');

-- The coat class the breed should always have carried.
update breeds
set default_pricing_class = 'EXTRA_FLOOF', updated_at = now()
where normalized_name = 'irish water spaniel'
  and pet_type_id = (select id from pet_types where normalized_name = 'dog');

-- The duplicate spelling stops being selectable...
update breeds
set active = false, updated_at = now()
where normalized_name = 'irish water dog'
  and pet_type_id = (select id from pet_types where normalized_name = 'dog');

-- ...and becomes an alias that resolves onto the surviving canonical row. SAFE_EXACT because
-- the two names denote the same animal and, after the reclass above, the same coat class -
-- so the fold cannot move a price.
insert into breed_aliases (pet_type_id, breed_id, name, normalized_name, alias_kind)
select canonical.pet_type_id, canonical.id, 'Irish Water Dog', 'irish water dog', 'SAFE_EXACT_ALIAS'
from breeds canonical
join pet_types pet_type on pet_type.id = canonical.pet_type_id
where pet_type.normalized_name = 'dog'
  and canonical.normalized_name = 'irish water spaniel'
on conflict (pet_type_id, normalized_name) do update
  set breed_id = excluded.breed_id,
      name = excluded.name,
      alias_kind = excluded.alias_kind;

insert into schema_migrations(version) values ('0032_consolidate_water_spaniel_and_retire_sheep_dog');
commit;
