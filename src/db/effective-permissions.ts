import type { SqlExecutor } from "./client.js";

/**
 * The one definition of "what may this membership actually do".
 *
 * Effective permissions for a non-owner membership are:
 *
 *   * `role_id` set and the role enabled  -> the ROLE's permissions;
 *   * `role_id` set and the role disabled -> NOTHING. Disabling a role is a real kill switch, not
 *     a "hide it from the picker" flag: the members keep their assignment, so re-enabling restores
 *     exactly the access it granted before, which is what makes it usable during an incident;
 *   * `role_id` null -> the membership's own `permissions` column. This is the TRANSITIONAL arm.
 *     Migration 0041 backfilled every non-owner membership onto a role, so no such row exists in
 *     migrated data; it is here so the roles change is revertible by reverting code alone, and it
 *     disappears with the column.
 *
 * Owners are unaffected by all of it. `can()` short-circuits on `isOwner` before permissions are
 * consulted, and 0041 leaves every owner's `role_id` null on purpose.
 *
 * WHY THIS IS A FRAGMENT AND NOT A VIEW OR A HAND-WRITTEN JOIN. Permission resolution happens at
 * eight places spread across the auth middleware, the route module and the engagement worker.
 * Eight hand-written joins would be eight chances for one of them to forget the `enabled` check
 * and quietly keep granting access through a role an owner believed they had switched off - and
 * the one that forgot would be a privilege-escalation bug that no type checker could see. A view
 * would hide the tenant predicate that every caller must still supply. So callers pass the alias
 * their query already uses and compose the result, the same way `assignedToEmployees` and
 * `reportedInvoices` are composed in `/api/reports`.
 *
 * The correlated subquery cannot miss: `(business_id, role_id)` is a composite foreign key onto
 * `roles (business_id, id)` with `on delete restrict`, so a set `role_id` always names a live role
 * OWNED BY THE SAME BUSINESS. The `coalesce` is therefore unreachable, and is kept only so this
 * expression is guaranteed to be a real array rather than null - callers project it straight into
 * an API response. Note that if it ever did fire, the result is the empty set: this expression
 * fails closed in every direction.
 *
 * @param db     the executor the enclosing query runs on - pass the transaction inside `db.begin`.
 * @param alias  how the enclosing query names `business_memberships` (or
 *               `membership_invitations`, which carries the same two columns).
 */
export function effectivePermissions(db: SqlExecutor, alias: string) {
  return db`(
    case
      when ${db(alias)}.role_id is null then ${db(alias)}.permissions
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
 * every existing call site already wrote `is_owner or <permission> = any(...)` by hand and one of
 * them omitting it would lock owners out of their own workspace.
 */
export function hasEffectivePermission(db: SqlExecutor, alias: string, permission: string) {
  return db`(${db(alias)}.is_owner or ${permission} = any(${effectivePermissions(db, alias)}))`;
}
