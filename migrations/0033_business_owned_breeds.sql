begin;

-- ---------------------------------------------------------------------------
-- Business-owned breeds.
--
-- SCOPE. Ownership is the BUSINESS - the customer account - not a salon location. `locations`
-- carries `business_id`, so an account owns many locations; a breed created here is therefore
-- visible at every location that account operates, which is the intended product behaviour. A
-- breed is never scoped to one location, and there is deliberately no `location_id` here.
--
-- A business may CREATE, RENAME and DELETE breeds of its own. It may never rename or delete a
-- shared Pawsh breed: a rename would change identity for all 4,130 tenants and destroy the
-- stable-identity property this taxonomy exists to provide, and a delete would remove a row
-- other tenants' pets point at. For a shared breed the account's controls stay exactly what
-- they already are - pricing class and active/inactive, recorded sparsely in
-- `business_breed_settings`, which is likewise keyed on `business_id` and so also applies
-- account-wide rather than per location.
--
-- WHY A NULLABLE business_id ON `breeds` RATHER THAN A SECOND TABLE.
--
-- `pets` carries `foreign key (pet_type_id, breed_id) references breeds(pet_type_id, id)`. A
-- separate table for account-created breeds cannot satisfy that constraint. Taking that route
-- would mean either dropping the composite key - giving up "a Cat cannot be a Golden Retriever"
-- as a database fact - or adding a parallel `custom_breed_id` column to `pets` and a parallel
-- resolution path through every consumer: the pet write resolver, the catalog projection, the
-- pricing resolver, alias resolution and the settings endpoint. That is a second breed identity
-- space, which is the exact shape 0028-0032 removed. One nullable column keeps a breed id a
-- breed id: every existing consumer needs one added predicate instead of a second branch.
--
-- THIS STAYS SPARSE. `breeds` gains a row only when an account actually creates one. It does
-- not gain a row per business per breed, and the 273 shared rows are untouched. Nothing here
-- can rebuild the 1,020,258-row duplication that 0030 dropped.
--
-- WHAT IS NOT EXPRESSIBLE AS A FOREIGN KEY. `pets` cannot carry a composite key onto
-- `(business_id, pet_type_id, id)` because a shared breed's `business_id` is null and would
-- never match a pet's. Cross-tenant breed selection is therefore blocked by the tenant
-- predicate every breed query in the API carries and by the `pet_breed_tenant` trigger below.
-- ---------------------------------------------------------------------------

alter table breeds
  add column business_id uuid references businesses(id);

comment on column breeds.business_id is
  'null: shared Pawsh taxonomy - readable by every tenant, renamable and deletable by none. non-null: a breed this business created - visible, renamable and deletable only by it, across every location that business operates.';

-- ---------------------------------------------------------------------------
-- Uniqueness. Three distinct rules, deliberately split.
--
--   1. The shared taxonomy keeps EXACTLY the semantics it had - one canonical spelling per pet
--      type - now expressed as a partial index over the shared rows.
--   2. An account's own names are unique within that account. Two businesses both adding
--      "Cavapoochon" are two independent rows with two independent ids; neither can see or
--      affect the other, so they must not collide.
--   3. A business name may not duplicate a SHARED name for the same pet type. That is not
--      expressible as a unique index - it is a rule about one partition against the other -
--      so it is a trigger. Without it an account could add a second "Poodle" that reads as a
--      duplicate in the catalog and makes name-based text resolution ambiguous.
-- ---------------------------------------------------------------------------
alter table breeds drop constraint breeds_pet_type_id_normalized_name_key;

create unique index breed_shared_name on breeds (pet_type_id, normalized_name)
  where business_id is null;

create unique index breed_business_name on breeds (business_id, pet_type_id, normalized_name)
  where business_id is not null;

-- Serves the cross-partition guard below, the API's pre-flight collision check, and the
-- name-based breed text resolution in the pet write path.
create index breed_name_scope_lookup on breeds (pet_type_id, normalized_name);

create function breed_name_scope_guard() returns trigger
language plpgsql as $$
declare conflicting_scope text;
begin
  select case when breed.business_id is null then 'the shared Pawsh taxonomy' else 'this business' end
    into conflicting_scope
  from breeds breed
  where breed.pet_type_id = new.pet_type_id
    and breed.normalized_name = new.normalized_name
    and breed.id <> new.id
    -- Only shared-vs-business pairs conflict. Two different businesses using one name is
    -- legitimate and is governed by `breed_business_name`; shared-vs-shared is governed by
    -- `breed_shared_name`.
    and (breed.business_id is null) <> (new.business_id is null)
  limit 1;

  if conflicting_scope is not null then
    raise exception using
      errcode = 'unique_violation',
      message = format('breed name "%s" already exists in %s for this pet type',
        new.name, conflicting_scope),
      hint = 'A business-created breed and a shared Pawsh breed cannot share a name.';
  end if;
  return new;
end $$;

-- Fires in BOTH directions on purpose. A future migration that adds a name to the shared
-- taxonomy which some business already created will be refused here rather than silently
-- producing two rows with one name. That migration must decide what happens to the existing
-- business row first, the same way 0031 and 0032 refuse to guess.
create trigger breed_name_scope
  before insert or update of business_id, pet_type_id, normalized_name, name on breeds
  for each row execute function breed_name_scope_guard();

-- ---------------------------------------------------------------------------
-- Row-level security. `breeds` now holds tenant rows, and the one-time `tenant_isolation` loop
-- in 0001 cannot cover it - it ran once, and its predicate would hide every shared row anyway
-- because `null = <tenant>` is not true. So the two policies this table needs are declared
-- here: permissive policies OR together, so a tenant would SELECT shared rows plus its own and
-- could write only rows carrying its own business_id.
--
-- READ THIS BEFORE RELYING ON IT. These policies do NOT enforce anything today, and nothing in
-- this file should be read as claiming they do. Pawsh connects as the owner of these tables and
-- no table sets FORCE ROW LEVEL SECURITY, and PostgreSQL exempts a table's owner from its own
-- policies. That is pre-existing and repository-wide: every one of the ~223
-- `where business_id = ...` predicates in the API is load-bearing for exactly this reason.
-- These policies are declared so `breeds` is already correct on the day a non-owner application
-- role is introduced and RLS is forced - not because they close anything today.
--
-- What actually enforces the rules on this table right now:
--   * shared breeds cannot be renamed or deleted - the API refuses it (BREED_NOT_BUSINESS_OWNED);
--   * a pet cannot reference another account's breed - the `pet_breed_tenant` trigger below;
--   * name collisions - the two unique indexes and the `breed_name_scope` trigger above.
-- Triggers and constraints, unlike policies, do apply to the table owner, so the second and
-- third of those hold even against direct SQL.
-- ---------------------------------------------------------------------------
alter table breeds enable row level security;

create policy shared_taxonomy_read on breeds for select
  using (
    business_id is null
    or business_id = nullif(current_setting('app.business_id', true), '')::uuid
  );

create policy tenant_isolation on breeds
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- A pet may never reference another account's breed.
--
-- The composite foreign key proves the breed belongs to the pet's TYPE; it cannot prove it
-- belongs to the pet's BUSINESS, for the reason recorded at the top of this file. This trigger
-- closes that gap as a database fact rather than an API convention, and unlike the policies
-- above it does apply to the owner connection Pawsh actually uses. It short-circuits when
-- `breed_id` is unchanged, so an ordinary pet edit costs nothing.
--
-- It deliberately does not care WHICH location the pet belongs to: breeds are owned by the
-- account, so every location under that account may use them.
-- ---------------------------------------------------------------------------
create function pet_breed_tenant_guard() returns trigger
language plpgsql as $$
begin
  if new.breed_id is null then return new; end if;
  if tg_op = 'UPDATE'
     and old.breed_id is not distinct from new.breed_id
     and old.business_id is not distinct from new.business_id then
    return new;
  end if;
  if exists (
    select 1 from breeds breed
    where breed.id = new.breed_id
      and breed.business_id is not null
      and breed.business_id <> new.business_id
  ) then
    raise exception 'a pet cannot reference a breed owned by another business';
  end if;
  return new;
end $$;

create trigger pet_breed_tenant
  before insert or update of breed_id, business_id on pets
  for each row execute function pet_breed_tenant_guard();

-- ---------------------------------------------------------------------------
-- Deleting an account's own breed must not be blocked by that account's own override of it.
--
-- A `business_breed_settings` row is a tenant opinion about a breed, not an independent
-- record: when the breed it describes is gone the opinion is meaningless. Only a
-- business-owned breed is ever deletable, so this cascade can only ever remove that same
-- account's override. Pets are deliberately NOT cascaded - the API refuses the delete instead,
-- because nulling `pets.breed_id` would drop those pets to STANDARD and silently reprice them.
-- ---------------------------------------------------------------------------
alter table business_breed_settings
  drop constraint business_breed_settings_breed_id_fkey,
  add constraint business_breed_settings_breed_id_fkey
    foreign key (breed_id) references breeds(id) on delete cascade;

insert into schema_migrations(version) values ('0033_business_owned_breeds');
commit;
