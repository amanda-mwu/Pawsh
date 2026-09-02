# Authorization

Owners have protected full authority. A non-owner membership is assigned a **role**, and the role's permissions are what that membership can do. Roles belong to one business, and a membership can only reference a role its own business owns — enforced by a composite foreign key on `(business_id, role_id)`, not by a route.

A role can be disabled. Disabling is a real kill switch, not a "hide it from the picker" flag: a disabled role grants nothing at all, while the members assigned to it keep their assignment, so re-enabling restores exactly the access it granted before. Owners are unaffected, because they hold no role and are authorized by `is_owner`.

Effective permissions are resolved by one shared SQL fragment (`effectivePermissions`) composed at every site that reads them, rather than by hand-written joins that could each forget the `enabled` check. Resolution happens on **every request** — nothing about a membership's authority is cached in the session or the token — so editing a role, disabling it, or reassigning a member takes effect on the next request that session makes, with no re-login and no session invalidation.

There is no fallback. Migration 0042 dropped the denormalised `permissions` columns and added `membership_role_matches_ownership`, so an owner **always** has `role_id` null and a non-owner **always** has one: "a non-owner with no role" is no longer representable. That matters, because that state resolves to the empty set — a person silently locked out — and a check constraint, unlike a row policy, applies to the table owner Pawsh connects as.

Ownership transfer is the one operation that crosses that line in both directions, so it must say what the outgoing owner keeps. **The caller names a role for the person being demoted, and the transfer is refused without one.** No default, no auto-minted "former owner" role, no falling through: the promoted member is moved off their role and the demoted member onto the named one in a single transaction, so there is no instant at which either resolves to nothing. `prevent_last_owner_loss` still governs the promotion half, which is why the promotion is written before the demotion — reversed, the trigger would refuse every transfer.

Changing what a member can do therefore has exactly two entry points: assign them a different role (`PATCH /api/members/:id/role`), or change what their role grants (`PATCH /api/roles/:id`), where it is visible to everyone holding it. The per-member permissions endpoint was retired: a per-member list would have been a second, invisible grant sitting beside the role, and the two would disagree the first time either changed.

Groomer, Receptionist and Manager are **built-in Pawsh roles**. 0041 seeded them into every business that existed when it ran, and `provisionRoleCatalog` - composed into `provisionBusinessCatalog`, the same authority a signup already used for services, tax and payment methods - gives them to every business created since, deriving their permissions from `builtInRoles` rather than from a second hand-written copy. Provisioning is insert-only and keyed on the role name case-insensitively, so re-running it adds nothing and never overwrites a role the salon authored.

A built-in role is a Pawsh template rather than salon property, so its **name is its identity**: it cannot be renamed (`ROLE_BUILT_IN_NAME_IMMUTABLE`) and cannot be deleted (`ROLE_BUILT_IN_UNDELETABLE`), both refused with 409. Retiring one is expressed by **disabling** it, which is supported and reversible: it grants nothing while off, members keep their assignment, and re-enabling restores exactly the access it granted before under the same id. Editing what a built-in grants is permitted, as it is for a built-in payment method.

The order the three appear in is a stated fact, not a spelling accident. `roles.sort_order` (0044) carries the position each holds in `builtInRoles`, and the roles list orders by `built_in desc, sort_order, lower(name)` - so Manager sits directly under the Owner because it is first in that array, custom roles sort after every built-in on the shared default, and a built-in added later lands where the array says rather than where its first letter falls.

Preset names are still never used for server authorization: a role seeded from a preset stores that preset's permission array, and authorization reads the array, never the name.

## Permissions that gate nothing yet

The catalog is deliberately larger than what is enforced. `unenforcedPermissions` names every permission that is stored, grantable and returned but protects no route today, and `GET /api/permissions` reports it per permission as `enforced: false` so the Roles editor can say so rather than presenting a dead switch as a live one. A switch that looks like it restricts something and does not is worse than no switch, because an owner would believe they had restricted something.

**A permission is added to the catalog before its route is split, never in the same change.** The Role Permission taxonomy landed as 55 keys that alter no route at all, all 55 unenforced, and each one graduates in a later change that splits exactly one route family and empties it from that set. Doing both at once would mean nothing distinguishes "this switch is new" from "this switch has just started refusing somebody", which is how a silent authorization hole gets in.

Two consequences worth knowing. `settings.manage` remains the permission that actually gates the ~25 settings routes; the `settings.*` children beneath it are the map of how it will be broken up, and are unenforced until their routes really are. And the four scope permissions - `appointments.view_all_staff`, `appointments.edit_all_staff`, `customers.view_all`, `dashboard.all_staff` - are the only ones whose *absence* would remove access rather than a split moving it, so enforcing them is a deliberate reduction and needs its own decision.

New permissions must also reach the roles that already exist. `permissionPresets.manager` is the whole tuple, so a role being created picks up a new key for free, but `provisionRoleCatalog` never updates a role already in the database - which is why 0043 and 0045 exist, each granting a new taxonomy to the roles that could already reach what it describes. `tests/domain/permission-catalog.test.ts` models that chain and fails if a permission reaches no existing role, so the omission has to be a decision rather than something arrived at quietly.

An invitation names a role rather than carrying a copy of its permissions, so somebody invited last week who accepts today arrives holding the role as it stands today. Accepting or revoking an invitation releases its role reference, so a consumed or revoked invitation stops blocking that role's deletion.

Every protected route resolves the session and verifies active user, membership, and business state. A requested business identifier is accepted only if the authenticated user has an active membership in that business. Mutation routes enforce the relevant permission on the server.

The final active owner cannot be removed or stripped of ownership by normal updates. PostgreSQL row policies provide tenant defense in depth for tenant-owned tables.

Personal account data is separate from tenant and employee data. The `users`
record owns login email, password credentials, and the user's display name;
`business_memberships` owns workspace access and the assigned role; and an optional
`employees` record owns operational scheduling identity. `/api/me` presents the
authenticated account and current membership without exposing credential or
session internals. Users may update only their own display name. Login email is
read-only, and role, permissions, and business identity remain controlled by
workspace authorization flows. An authenticated password change verifies the
current password and revokes the user's other active sessions.
