begin;

-- ---------------------------------------------------------------------------
-- Named roles, and the backfill that moves every existing membership onto one
-- WITHOUT CHANGING ANYONE'S EFFECTIVE ACCESS.
--
-- Until now a non-owner's authority was a flat `text[]` denormalised onto
-- `business_memberships` and `membership_invitations`. Two people doing the same
-- job carried two independent copies of the same list, so "what can a
-- receptionist do here" had as many answers as there were receptionists and
-- changing the answer meant editing every row by hand.
--
-- This migration introduces `roles` and points memberships and invitations at
-- them. It does NOT stop reading the old columns - see the note at the bottom
-- about why `permissions` is left populated - and it does not change a single
-- person's effective permission set. That last property is the release gate and
-- is asserted directly by `tests/database/roles-backfill.test.ts`.
--
-- THE COMPOSITE FOREIGN KEY IS THE POINT OF THIS FILE, not the table.
-- `foreign key (business_id, role_id) references roles (business_id, id)` is
-- what makes it impossible for a membership in business A to reference a role
-- belonging to business B. A plain `role_id uuid references roles(id)` would
-- accept that row, and NOTHING ELSE IN THE SYSTEM WOULD CATCH IT: the
-- `tenant_isolation` policies declared throughout this schema do not enforce
-- anything today, because Pawsh connects as the owner of these tables, no table
-- sets FORCE ROW LEVEL SECURITY, and PostgreSQL exempts a table's owner from its
-- own policies. See the long note in 0033 for the full explanation. Tenant
-- isolation in Pawsh is carried by `where business_id = ...` predicates in the
-- API and by composite keys like this one in the schema. A cross-tenant role
-- grant is a privilege-escalation bug, so it is refused by the database rather
-- than by a route that somebody may later forget to write. `employees` carries
-- `unique (business_id, id)` for exactly this reason (see 0040), and this table
-- follows it.
--
-- `on delete restrict` rather than `set null`: a role that is still assigned
-- cannot be deleted. Nulling the column instead would silently fall the member
-- back onto the transitional `permissions` column - and, after that column is
-- dropped, onto nothing at all - which is a permission change nobody asked for.
-- ---------------------------------------------------------------------------

create table roles (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (description is null or char_length(description) <= 500),
  permissions text[] not null default '{}',
  -- The kill switch. A disabled role grants NOTHING - it is not a soft "hidden
  -- from the picker" flag. Members keep their assignment, so re-enabling the
  -- role restores exactly the access it granted before, which is what makes it
  -- usable in an incident.
  enabled boolean not null default true,
  -- True only for a role this migration seeded from one of the three shipped
  -- presets. It is descriptive - it tells the UI "Pawsh named this one" - and
  -- confers no protection: a built-in role can be renamed, edited, disabled and
  -- deleted like any other.
  built_in boolean not null default false,
  -- Optimistic concurrency, the same way `locations.version` guards location
  -- settings. Two owners editing one role in two tabs must not silently
  -- overwrite each other, and permissions are the last place to accept a lost
  -- update.
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The composite-foreign-key target described above. Redundant with the
  -- primary key for uniqueness purposes; it exists so the referencing tables can
  -- name (business_id, id) as a pair.
  unique (business_id, id)
);

-- One role name per business, compared case-insensitively so "Groomer" and
-- "groomer" cannot both exist and leave an owner guessing which one they
-- assigned. Scoped to the business: two salons may both have a "Groomer".
create unique index roles_unique_name_per_business
  on roles (business_id, lower(name));

alter table business_memberships add column role_id uuid;
alter table membership_invitations add column role_id uuid;

-- ---------------------------------------------------------------------------
-- Row-level security, declared here for the same reason 0027 and 0033 declare
-- theirs inline: the bulk `tenant_isolation` loop in 0001 ran once, against the
-- tables that existed then, and cannot cover a table created later.
--
-- READ THIS BEFORE RELYING ON IT. This policy does NOT enforce anything today,
-- exactly as 0033 says of `breeds`. It is declared so `roles` is already correct
-- on the day a non-owner application role is introduced and RLS is forced - not
-- because it closes anything now. What actually prevents a cross-tenant role
-- reference today is the composite foreign key above, which, being a constraint
-- rather than a policy, DOES apply to the table owner.
-- ---------------------------------------------------------------------------
alter table roles enable row level security;
create policy tenant_isolation on roles
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- BACKFILL
--
-- Rules, in order of precedence:
--
--   1. Permission sets are compared as SETS, not as arrays. Order and duplicates
--      in the stored `text[]` are noise: two memberships holding the same
--      permissions in a different order are the same role and must collapse into
--      one. Every set below is canonicalised through the identical expression -
--      `array_agg(distinct p order by p)` over `unnest(...)` - so both sides of
--      every comparison sort under the same collation. Comparing a canonicalised
--      set against a hand-sorted literal would be a collation bug waiting to
--      happen, so no literal in this file is hand-sorted.
--
--   2. A set matching one of the three shipped presets is seeded as `Groomer`,
--      `Receptionist` or `Manager` with `built_in = true`, and stores THAT
--      PRESET'S ARRAY, which is set-identical to what the members held.
--
--   3. Every other non-empty set becomes `Custom access N`, numbered per
--      business, storing the canonicalised set verbatim.
--
--   4. The empty set becomes `No access`. It is a rule-3 role with a name a
--      human can read, not a fourth preset, so `built_in` stays false.
--
--   5. OWNERS ARE NOT TOUCHED AND KEEP `role_id` NULL. Owner authority is
--      `is_owner` plus the `protect_last_owner` trigger from 0001, and `can()`
--      short-circuits on it before permissions are consulted. Seeding an "Admin"
--      role would create a second way to express one thing, and it would fight
--      `prevent_last_owner_loss` the moment somebody unassigned it.
--
--   6. Memberships and invitations draw from ONE per-business role set, so an
--      invitation that grants what an existing member already has points at that
--      member's role rather than minting a duplicate.
--
-- Disabled and suspended memberships are backfilled too. They are not dead rows:
-- approving a workspace access request reactivates an existing membership, and a
-- row that came back with `role_id` null would have lost its permissions the day
-- the old column is dropped.
--
-- Invitations are backfilled only while `accepted_at is null and revoked_at is
-- null`. An accepted invitation has already become a membership and a revoked
-- one grants nothing, so neither needs a role - and, more importantly, a dead
-- invitation holding a `role_id` would keep `on delete restrict` blocking the
-- deletion of a role that nothing live is using.
-- ---------------------------------------------------------------------------

create temporary table role_backfill_holder on commit drop as
select
  membership.business_id,
  membership.id as membership_id,
  null::uuid as invitation_id,
  coalesce(
    (select array_agg(distinct p order by p) from unnest(membership.permissions) p),
    '{}'::text[]
  ) as canonical_permissions
from business_memberships membership
where not membership.is_owner
union all
select
  invitation.business_id,
  null::uuid,
  invitation.id,
  coalesce(
    (select array_agg(distinct p order by p) from unnest(invitation.permissions) p),
    '{}'::text[]
  )
from membership_invitations invitation
where invitation.accepted_at is null and invitation.revoked_at is null;

-- The three shipped presets, canonicalised through the same expression the
-- holder sets went through. `exact_permissions` is what a matched role stores;
-- `canonical_permissions` is what it is matched on.
create temporary table role_backfill_preset on commit drop as
select
  candidate.name,
  candidate.exact_permissions,
  coalesce(
    (select array_agg(distinct p order by p) from unnest(candidate.exact_permissions) p),
    '{}'::text[]
  ) as canonical_permissions
from (
  values
    ('Groomer', array[
      'calendar.view','appointments.view','pets.view','pets.care.view',
      'operations.check_in','operations.perform_service','operations.complete'
    ]),
    ('Receptionist', array[
      'calendar.view','appointments.view','appointments.create','appointments.edit',
      'appointments.cancel','customers.view','customers.edit','pets.view','pets.edit',
      'pets.care.view','operations.check_in','checkout.perform','payments.view'
    ]),
    ('Manager', array[
      'calendar.view','appointments.view','appointments.create','appointments.edit',
      'appointments.cancel','appointments.override_conflict','customers.view','customers.edit',
      'pets.view','pets.edit','pets.care.view','pets.care.edit','operations.check_in',
      'operations.perform_service','operations.complete','checkout.perform','payments.view',
      'discounts.apply','services.manage','team.manage','reports.view','settings.manage'
    ])
) as candidate(name, exact_permissions);

-- One row per (business, distinct permission set), already named and numbered.
-- `Custom access` numbering orders by the canonical array so the result is
-- deterministic and a re-run on a copy of the same data produces the same names.
create temporary table role_backfill_seed on commit drop as
select
  distinct_set.business_id,
  distinct_set.canonical_permissions,
  coalesce(preset.name,
    case
      when cardinality(distinct_set.canonical_permissions) = 0 then 'No access'
      else 'Custom access ' || row_number() over (
        partition by distinct_set.business_id,
          (preset.name is null and cardinality(distinct_set.canonical_permissions) > 0)
        order by distinct_set.canonical_permissions
      )::text
    end
  ) as name,
  coalesce(preset.exact_permissions, distinct_set.canonical_permissions) as stored_permissions,
  (preset.name is not null) as built_in
from (
  select distinct business_id, canonical_permissions from role_backfill_holder
) distinct_set
left join role_backfill_preset preset
  on preset.canonical_permissions = distinct_set.canonical_permissions;

insert into roles (business_id, name, permissions, built_in)
select business_id, name, stored_permissions, built_in from role_backfill_seed;

update business_memberships membership
set role_id = seeded.id, updated_at = now()
from role_backfill_holder holder
join role_backfill_seed seed
  on seed.business_id = holder.business_id
  and seed.canonical_permissions = holder.canonical_permissions
join roles seeded
  on seeded.business_id = seed.business_id and seeded.name = seed.name
where holder.membership_id = membership.id;

update membership_invitations invitation
set role_id = seeded.id
from role_backfill_holder holder
join role_backfill_seed seed
  on seed.business_id = holder.business_id
  and seed.canonical_permissions = holder.canonical_permissions
join roles seeded
  on seeded.business_id = seed.business_id and seeded.name = seed.name
where holder.invitation_id = invitation.id;

-- ---------------------------------------------------------------------------
-- The composite foreign keys are added AFTER the backfill so the existing rows
-- are validated by the same constraint that will guard every future write,
-- rather than being trusted because this file wrote them.
--
-- `role_id` is nullable and the default MATCH SIMPLE semantics mean a row with
-- `role_id` null is not checked at all - which is precisely what owners and
-- not-yet-migrated rows need.
-- ---------------------------------------------------------------------------
alter table business_memberships
  add constraint business_memberships_role_tenant
    foreign key (business_id, role_id) references roles (business_id, id)
    on delete restrict;

alter table membership_invitations
  add constraint membership_invitations_role_tenant
    foreign key (business_id, role_id) references roles (business_id, id)
    on delete restrict;

-- ---------------------------------------------------------------------------
-- `business_memberships.permissions` and `membership_invitations.permissions`
-- ARE DELIBERATELY LEFT POPULATED AND UNTOUCHED.
--
-- Effective permissions now resolve through the role whenever `role_id` is set,
-- so these columns stop being read. They are kept because that makes this
-- change revertible by reverting code alone: put the old queries back and every
-- membership still holds the list it held this morning. They are dropped in a
-- later migration, once the roles API has shipped and the read path has been
-- exercised in production.
--
-- Nothing may start writing to them expecting to be read. The one remaining
-- writer, `PATCH /api/members/:id/permissions`, is retired in the same phase
-- that drops the columns.
-- ---------------------------------------------------------------------------

insert into schema_migrations(version) values ('0041_roles');
commit;
