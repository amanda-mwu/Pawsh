begin;

-- ---------------------------------------------------------------------------
-- `appointments.edit_all_staff` starts enforcing, and nobody loses anything.
--
-- Until this change `appointments.edit` meant "any appointment in the salon",
-- `calendar.blocks_create` and `calendar.blocks_edit` meant "any groomer's
-- calendar", and `appointments.edit_all_staff` - reserved by 0045 and listed as
-- unenforced ever since - gated nothing. From this change on every route that
-- edits, moves or re-services an appointment, records a service note on it,
-- transitions it, or creates, changes or removes a blocked time, asks whether
-- the row is ASSIGNED TO THE CALLER'S OWN EMPLOYEE RECORD, and refuses when it
-- is not. `appointments.edit_all_staff` is the key that says the answer does
-- not matter.
--
-- So the meaning of three keys NARROWED, from "anyone's" to "mine", and this
-- file is what keeps that narrowing from taking a capability away from a role
-- that has it today. It is a data migration and nothing else: no column, no
-- index, no row deleted, and its only statements are UPDATEs against `roles`
-- that grant and never revoke.
--
-- TWO STEPS, AND THE ORDER IS THE WHOLE DESIGN.
--
--   1. Every role holding ANY of the three narrowed keys gains
--      `appointments.edit_all_staff`. That is exactly the set of roles that
--      can reach across the staff today, expressed relationally - following
--      0043's `where 'reports.view' = any(permissions)` and 0055's
--      `where 'appointments.edit' = any(permissions)` - so a renamed built-in
--      and a salon's own front-desk role are both covered and no name is
--      consulted. After this step the set of appointments and blocks each
--      existing role may change is IDENTICAL to what it was before.
--
--   2. Every built-in role named Groomer gains `appointments.edit`,
--      `calendar.blocks_create` and `calendar.blocks_edit`. This is the one
--      deliberate widening: a groomer may now move, re-service and annotate
--      the appointments assigned to them and block out their own calendar,
--      which they could not do at all before. The shipped Groomer preset gains
--      the same three keys in the same change, so a salon that signs up
--      tomorrow and a salon migrated by this file get the same Groomer.
--
--   Step 1 runs BEFORE step 2, and that is why a Groomer does not pick up
--   `appointments.edit_all_staff` on the way through: when step 1 looks, the
--   built-in Groomer holds none of the three keys, so it matches nothing, and
--   step 2 then gives it the scoped keys alone. Reversed, step 1 would find
--   every Groomer holding `appointments.edit` and hand it the whole salon.
--
-- STEP 2 IS NOMINAL WHERE STEP 1 IS RELATIONAL, on purpose. A built-in's name
-- IS its identity - the roles API refuses to rename one - so `built_in` and
-- the name together are the only honest way to say "the Groomer Pawsh shipped".
-- A custom role a salon built for its groomers is not touched by step 2: that
-- role means whatever the owner made it mean, and if they want it to run its
-- own day the switch is in the editor. Step 1 still covers such a role if it
-- already held one of the three keys, which is the case that matters.
--
-- WHAT NOBODY GAINS. A role holding none of the three keys - a viewer, a
-- checkout-only desk, a custom groomer role built without them - matches
-- neither step and is not touched. An owner is unaffected in both directions:
-- ownership is a flag on the membership, not a permission, and every check
-- short-circuits on it. A membership with no employee record holding
-- `appointments.edit` and not the all-staff key is refused every appointment
-- edit after this change, because nothing is assigned to it; step 1 is what
-- makes that state unreachable for any role that exists today.
--
-- IDEMPOTENT, INCLUDING THE VERSION BUMPS, following 0055 - and step 1 needs
-- more than 0055 needed to get there. Step 2's predicate excludes the roles it
-- has already reached, so it is a no-op the second time on its own. Step 1's
-- cannot be: the moment step 2 has run, every built-in Groomer holds the three
-- scoped keys, which is exactly what step 1 matches on, and a second pass would
-- hand every Groomer the whole salon - the one outcome the step order exists to
-- prevent. The pre-state step 1 reasons about is gone once this file has run,
-- so the file RECORDS THAT IT HAS RUN, in `schema_migrations`, the ledger that
-- exists for precisely that fact, and step 1 refuses to run while the record is
-- there. 0001, 0015 and 0017 record themselves the same way, and the runner
-- inserts `on conflict do nothing` for exactly this case. A re-run therefore
-- grants nothing and moves no `version` - a re-run that bumped every role's
-- version would tell an editor somebody has open that its copy went stale for
-- no reason. The bump on a role that DID change is deliberate, for 0043's and
-- 0045's reason: an editor holding the old copy must be refused rather than
-- allowed to write these grants back out.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Everyone who can reach across the staff today still can tomorrow.
-- ---------------------------------------------------------------------------
update roles
set permissions = (
    select array_agg(distinct permission order by permission)
    from unnest(
      permissions || array['appointments.edit_all_staff']
    ) as permission
  ),
  version = version + 1,
  updated_at = now()
where permissions && array['appointments.edit', 'calendar.blocks_create', 'calendar.blocks_edit']::text[]
  and not ('appointments.edit_all_staff' = any(permissions))
  and not exists (
    select 1 from schema_migrations where version = '0057_staff_scheduling_scope'
  );


-- ---------------------------------------------------------------------------
-- 2. The shipped Groomer may run its own day.
-- ---------------------------------------------------------------------------
update roles
set permissions = (
    select array_agg(distinct permission order by permission)
    from unnest(
      permissions || array['appointments.edit', 'calendar.blocks_create', 'calendar.blocks_edit']
    ) as permission
  ),
  version = version + 1,
  updated_at = now()
where built_in and lower(name) = 'groomer'
  and not (permissions @> array['appointments.edit', 'calendar.blocks_create', 'calendar.blocks_edit']::text[]);


-- ---------------------------------------------------------------------------
-- What was true when this ran.
--
-- The property step 1 exists to hold: after this file first runs, no role can
-- hold one of the three narrowed keys without either holding the all-staff key
-- or being a built-in Groomer. A role left in that state is one that silently
-- lost the reach it had, which is the failure this migration was written to
-- prevent. FIRST RUNS ONLY, on the same record step 1 consults: once the file
-- has run, an owner is free to author a role holding `appointments.edit` and
-- not the all-staff key - a custom groomer role scoped to its own day is the
-- whole point of the change - and a re-run must not call that a stranding.
--
-- And the property step 2 exists to hold: every built-in Groomer holds the
-- three scoped keys. The ORDER of the two steps is not assertable from here -
-- a Groomer an owner had granted the all-staff key beforehand is theirs to
-- have granted - so `tests/database/staff-scheduling-scope-migration-0057.test.ts`
-- pins it instead, by planting a built-in Groomer and asserting it comes out
-- without the all-staff key.
-- ---------------------------------------------------------------------------
do $$
declare
  stranded bigint;
begin
  if not exists (select 1 from schema_migrations where version = '0057_staff_scheduling_scope') then
    select count(*) into stranded from roles
    where permissions && array['appointments.edit', 'calendar.blocks_create', 'calendar.blocks_edit']::text[]
      and not ('appointments.edit_all_staff' = any(permissions))
      and not (built_in and lower(name) = 'groomer');
    if stranded > 0 then
      raise exception '% roles hold a staff-scoped key without appointments.edit_all_staff', stranded;
    end if;
  end if;

  select count(*) into stranded from roles
  where built_in and lower(name) = 'groomer'
    and not (permissions @> array['appointments.edit', 'calendar.blocks_create', 'calendar.blocks_edit']::text[]);
  if stranded > 0 then
    raise exception '% built-in Groomer roles were left unable to run their own day', stranded;
  end if;
end $$;

-- The record step 1 consults. Written LAST, after both steps and the assertion,
-- so a file that failed part way through has not marked itself done.
insert into schema_migrations (version) values ('0057_staff_scheduling_scope')
on conflict (version) do nothing;

commit;
