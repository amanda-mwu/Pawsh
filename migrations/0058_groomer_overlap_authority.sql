begin;

-- ---------------------------------------------------------------------------
-- The shipped Groomer may overlap its own day, and every workspace's Groomer
-- and Receptionist catch up with the preset.
--
-- `appointments.override_conflict` is the authority to lay one appointment
-- over another on the same calendar. It joined the Receptionist preset when
-- the overlap rule stopped asking twice, and was deliberately kept from the
-- Groomer preset - a groomer moving, extending or re-servicing one of their
-- own visits over another of their own was refused 409. The owner has ruled
-- that refusal wrong: a groomer running their own hour is exactly who should
-- decide whether two of their dogs share it. So the Groomer preset holds the
-- key now, in `permissionPresets`, and this file gives it to every built-in
-- Groomer that already exists, the way 0057 gave the same role its own day.
--
-- THE KEY SAYS NOTHING ABOUT WHOSE CALENDAR. Every appointment write still
-- asks whether the row is assigned to the caller's own employee record before
-- the overlap is judged, and `appointments.edit_all_staff` is still the only
-- key that says the answer does not matter. This file grants that key to
-- nobody. A Groomer that comes out of here overlaps the appointments assigned
-- to it and is refused a colleague's by `NOT_ASSIGNED_TO_YOU`, exactly as
-- before. Blocked time is untouched by the key in both directions: a block
-- refuses a holder as it refuses everyone else.
--
-- `appointments.service_price_edit` RIDES ALONG, for both roles. The Groomer
-- and Receptionist presets gained it when the price of one service on one
-- appointment graduated, and the Receptionist preset gained the override key
-- at the same time; each was recorded as a grant the presets carried ahead of
-- the migration that would give it to the roles that already exist. This is
-- that migration. Landing the Groomer's override key without the two keys the
-- same presets were already owed would leave a second file to write for the
-- same rows in the same shape.
--
-- A DATA MIGRATION AND NOTHING ELSE: no column, no index, no row deleted, and
-- its only statements are UPDATEs against `roles` that grant and never revoke.
--
-- NOMINAL, NOT RELATIONAL, following 0057's step 2. A built-in's name IS its
-- identity - the roles API refuses to rename one - so `built_in` and the name
-- together are the only honest way to say "the Groomer Pawsh shipped" and
-- "the Receptionist Pawsh shipped". A custom role a salon built for its
-- groomers is not touched: that role means whatever the owner made it mean,
-- and if they want it overlapping, the switch is in the editor. A built-in an
-- owner had already hand-widened keeps every key it holds - including an
-- all-staff key the owner chose to give it - and gains only what it lacks of
-- the two; nothing here promotes a Groomer beyond the preset.
--
-- WHAT NOBODY GAINS. The Manager already holds every key. A custom role of
-- any name, a viewer, a booking-only desk: not matched, not touched. An owner
-- is unaffected in both directions, because ownership is a flag on the
-- membership and every check short-circuits on it.
--
-- IDEMPOTENT, INCLUDING THE VERSION BUMPS, following 0055 and 0057's step 2.
-- Each predicate excludes the roles that already hold both keys, so a second
-- pass matches nothing and moves no `version` - a re-run that bumped every
-- role's version would tell an editor somebody has open that its copy went
-- stale for no reason. The bump on a role that DID change is deliberate, for
-- 0043's and 0045's reason: an editor holding the old copy must be refused
-- rather than allowed to write these grants back out. There is no pre-state
-- to preserve here, so unlike 0057 nothing consults `schema_migrations`; the
-- predicates are the whole guard.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The shipped Groomer may overlap its own day, and price its own work.
-- ---------------------------------------------------------------------------
update roles
set permissions = (
    select array_agg(distinct permission order by permission)
    from unnest(
      permissions || array['appointments.override_conflict', 'appointments.service_price_edit']
    ) as permission
  ),
  version = version + 1,
  updated_at = now()
where built_in and lower(name) = 'groomer'
  and not (permissions @> array['appointments.override_conflict', 'appointments.service_price_edit']::text[]);


-- ---------------------------------------------------------------------------
-- 2. The shipped Receptionist double-books on purpose, and prices the visit
--    in front of it - the two keys its preset has carried ahead of this file.
-- ---------------------------------------------------------------------------
update roles
set permissions = (
    select array_agg(distinct permission order by permission)
    from unnest(
      permissions || array['appointments.override_conflict', 'appointments.service_price_edit']
    ) as permission
  ),
  version = version + 1,
  updated_at = now()
where built_in and lower(name) = 'receptionist'
  and not (permissions @> array['appointments.override_conflict', 'appointments.service_price_edit']::text[]);


-- ---------------------------------------------------------------------------
-- What is true once this has run: every built-in Groomer and every built-in
-- Receptionist holds both keys. That no Groomer picked up the all-staff key
-- is not assertable from here - a Groomer an owner had granted it beforehand
-- is theirs to have granted - so
-- `tests/database/groomer-overlap-authority-migration-0058.test.ts` pins it
-- instead, by planting a plain and a hand-widened Groomer and asserting each
-- comes out with exactly the keys it lacked and nothing more.
-- ---------------------------------------------------------------------------
do $$
declare
  stranded bigint;
begin
  select count(*) into stranded from roles
  where built_in and lower(name) in ('groomer', 'receptionist')
    and not (permissions @> array['appointments.override_conflict', 'appointments.service_price_edit']::text[]);
  if stranded > 0 then
    raise exception '% built-in Groomer or Receptionist roles were left without the overlap and price keys', stranded;
  end if;
end $$;

commit;
