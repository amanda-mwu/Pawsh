import { permissions } from "@pawsh/domain";
import type { SqlExecutor } from "./client.js";

/**
 * The one definition of "what may this membership actually do".
 *
 *   * an OWNER holds everything. Owner authority is `is_owner` plus the `protect_last_owner`
 *     trigger from 0001, never a role, so it is expressed here rather than stored: `can()` already
 *     short-circuits on `is_owner`, and reporting the full tuple keeps `context.permissions` and
 *     every projection of it saying what an owner can actually do;
 *   * a non-owner holds THEIR ROLE's permissions, or NOTHING if that role is disabled. Disabling
 *     is a real kill switch, not a "hide it from the picker" flag: the members keep their
 *     assignment, so re-enabling restores exactly the access it granted before, which is what
 *     makes it usable during an incident.
 *
 * There is no third case. Migration 0042 dropped the denormalised `permissions` columns and added
 * `membership_role_matches_ownership`, so "a non-owner with no role" is no longer representable -
 * which matters, because that state resolves to the empty set and would be a person silently
 * locked out. The `coalesce` below is therefore unreachable for any row the constraint permits,
 * and is kept only so this expression always yields a real array rather than null; callers project
 * it straight into an API response. If it ever did fire the answer is the empty set: this
 * expression fails closed in every direction.
 *
 * WHY THIS IS A FRAGMENT AND NOT A VIEW OR A HAND-WRITTEN JOIN. Permission resolution happens at
 * eight places spread across the auth middleware, the route module and the engagement worker.
 * Eight hand-written joins would be eight chances for one of them to forget the `enabled` check
 * and quietly keep granting access through a role an owner believed they had switched off - and
 * the one that forgot would be a privilege-escalation bug no type checker could see. A view would
 * hide the tenant predicate every caller must still supply. So callers pass the alias their query
 * already uses and compose the result, the same way `assignedToEmployees` and `reportedInvoices`
 * are composed in `/api/reports`.
 *
 * @param db     the executor the enclosing query runs on - pass the transaction inside `db.begin`.
 * @param alias  how the enclosing query names `business_memberships`. The table must carry
 *               `is_owner`, `business_id` and `role_id`; invitations have no `is_owner` and are
 *               resolved by joining `roles` directly instead.
 */
export function effectivePermissions(db: SqlExecutor, alias: string) {
  return db`(
    case
      when ${db(alias)}.is_owner then ${permissions as unknown as string[]}::text[]
      else coalesce((
        select case when granting_role.enabled then granting_role.permissions else '{}'::text[] end
        from roles granting_role
        where granting_role.business_id = ${db(alias)}.business_id
          and granting_role.id = ${db(alias)}.role_id
      ), '{}'::text[])
    end
  )`;
}

/**
 * `true` when the membership at `alias` holds `permission`, owners included.
 *
 * The owner short-circuit is part of the expression rather than left to each call site, because
 * every call site had written `is_owner or <permission> = any(...)` by hand and one of them
 * omitting it would lock owners out of their own workspace.
 */
export function hasEffectivePermission(db: SqlExecutor, alias: string, permission: string) {
  return db`(${db(alias)}.is_owner or ${permission} = any(${effectivePermissions(db, alias)}))`;
}
