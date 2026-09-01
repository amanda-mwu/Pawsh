begin;

-- ---------------------------------------------------------------------------
-- Retires the denormalised permission columns. A membership's authority is now
-- its ROLE and nothing else.
--
-- 0041 introduced `roles`, backfilled every membership onto one, and
-- deliberately LEFT these two columns populated so that the riskiest change in
-- the authorization path could be undone by reverting code alone. That safety
-- net has done its job: the roles API has shipped, invitations and access
-- requests name roles, and nothing reads these columns any more.
--
-- Dropping them removes the transitional arm of `effectivePermissions` - the
-- one that fell back to `membership.permissions` when `role_id` was null. From
-- here, A NON-OWNER WITHOUT A ROLE RESOLVES TO THE EMPTY SET. That is why this
-- file does two things before it drops anything:
--
--   1. it backfills any membership or live invitation that reached this point
--      still holding a null `role_id`, preserving its effective access exactly;
--   2. it adds CHECK constraints making that state unrepresentable from now on,
--      so the empty-set outcome cannot be reached by a future code path that
--      forgets. A constraint, unlike a policy, applies to the table owner Pawsh
--      connects as - see 0033 - so this actually holds.
--
-- Stragglers are possible and are not a bug: between 0041 and this migration a
-- legacy `{email, permissions}` invitation could be accepted, producing a
-- membership with a permission list and no role. Refusing to run would be the
-- 0032/0039 posture, but it is the wrong one here - the data is not ambiguous,
-- it just has not been converted yet, and the conversion is the same set-match
-- 0041 already performed. So this migration converts rather than refuses.
-- ---------------------------------------------------------------------------

-- Every membership and live invitation that still has no role, with its
-- permission set canonicalised the same way 0041 canonicalised them: as a
-- SORTED SET, so order and duplicates cannot make two identical grants look
-- like two different roles.
create temporary table straggler on commit drop as
select
  membership.business_id,
  membership.id as membership_id,
  null::uuid as invitation_id,
  coalesce(
    (select array_agg(distinct p order by p) from unnest(membership.permissions) p),
    '{}'::text[]
  ) as canonical_permissions
from business_memberships membership
where not membership.is_owner and membership.role_id is null
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
where invitation.role_id is null
  and invitation.accepted_at is null and invitation.revoked_at is null;

-- An existing role whose permissions are the SAME SET is the role this straggler
-- already belongs on. Matching against what 0041 seeded is what keeps the
-- "nobody's access changes" property true a second time, and it avoids minting a
-- duplicate of a role the business already has.
create temporary table straggler_existing_role on commit drop as
select r.business_id, r.id as role_id,
  coalesce(
    (select array_agg(distinct p order by p) from unnest(r.permissions) p),
    '{}'::text[]
  ) as canonical_permissions
from roles r;

-- The sets that matched nothing and therefore need a role of their own. The
-- numbering continues past whatever `Custom access N` roles 0041 already
-- created in that business, so the unique index on (business_id, lower(name))
-- cannot be violated by a name this statement picks.
create temporary table straggler_new_role on commit drop as
select
  unmatched.business_id,
  unmatched.canonical_permissions,
  'Custom access ' || (
    coalesce((
      select max((substring(existing.name from '^Custom access ([0-9]+)$'))::int)
      from roles existing
      where existing.business_id = unmatched.business_id
        and existing.name ~ '^Custom access [0-9]+$'
    ), 0)
    + row_number() over (
        partition by unmatched.business_id order by unmatched.canonical_permissions
      )
  )::text as name
from (
  select distinct s.business_id, s.canonical_permissions
  from straggler s
  where not exists (
    select 1 from straggler_existing_role e
    where e.business_id = s.business_id
      and e.canonical_permissions = s.canonical_permissions
  )
) unmatched;

insert into roles (business_id, name, permissions, built_in)
select business_id, name, canonical_permissions, false from straggler_new_role;

-- One place to look up "the role for this business and this permission set",
-- covering both the roles that already existed and the ones just created.
create temporary table straggler_resolved on commit drop as
select r.business_id, r.id as role_id,
  coalesce(
    (select array_agg(distinct p order by p) from unnest(r.permissions) p),
    '{}'::text[]
  ) as canonical_permissions
from roles r;

update business_memberships membership
set role_id = resolved.role_id, updated_at = now()
from straggler s
join straggler_resolved resolved
  on resolved.business_id = s.business_id
  and resolved.canonical_permissions = s.canonical_permissions
where s.membership_id = membership.id;

update membership_invitations invitation
set role_id = resolved.role_id
from straggler s
join straggler_resolved resolved
  on resolved.business_id = s.business_id
  and resolved.canonical_permissions = s.canonical_permissions
where s.invitation_id = invitation.id;

-- ---------------------------------------------------------------------------
-- The invariants, now that they are true, made permanent.
--
-- A non-owner without a role resolves to the empty set, which is a person
-- silently locked out. An owner WITH a role is a dangling assignment that grants
-- nothing, blocks that role's deletion through `on delete restrict`, and would
-- start granting the moment they were demoted. Both are now unrepresentable.
--
-- Ownership transfer is the one operation that crosses this line in both
-- directions at once, which is why it moves the promoted member off their role
-- and the demoted member onto a role NAMED BY THE CALLER, in a single
-- transaction. There is no instant at which either row violates this check.
-- ---------------------------------------------------------------------------
alter table business_memberships
  add constraint membership_role_matches_ownership
    check ((is_owner and role_id is null) or (not is_owner and role_id is not null));

-- A live invitation must name the role it is offering. A consumed or revoked one
-- must have released it, so it stops blocking that role's deletion on behalf of
-- a row nobody can ever use.
alter table membership_invitations
  add constraint live_invitation_requires_role
    check (
      (accepted_at is null and revoked_at is null and role_id is not null)
      or ((accepted_at is not null or revoked_at is not null) and role_id is null)
    );

alter table business_memberships drop column permissions;
alter table membership_invitations drop column permissions;

insert into schema_migrations(version) values ('0042_retire_membership_permissions');
commit;
