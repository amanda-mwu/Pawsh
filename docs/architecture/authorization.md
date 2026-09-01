# Authorization

Owners have protected full authority. A non-owner membership is assigned a **role**, and the role's permissions are what that membership can do. Roles belong to one business, and a membership can only reference a role its own business owns — enforced by a composite foreign key on `(business_id, role_id)`, not by a route.

A role can be disabled. Disabling is a real kill switch, not a "hide it from the picker" flag: a disabled role grants nothing at all, while the members assigned to it keep their assignment, so re-enabling restores exactly the access it granted before. Owners are unaffected, because they hold no role and are authorized by `is_owner`.

Effective permissions are resolved by one shared SQL fragment (`effectivePermissions`) composed at every site that reads them, rather than by hand-written joins that could each forget the `enabled` check. Resolution happens on **every request** — nothing about a membership's authority is cached in the session or the token — so editing a role, disabling it, or reassigning a member takes effect on the next request that session makes, with no re-login and no session invalidation.

A membership whose `role_id` is null falls back to its own `permissions` column. That is a transitional state: migration 0041 backfilled every non-owner membership onto a role, and the column exists only so the change is revertible by reverting code. **The one path that still produces such a row is ownership transfer, which leaves the outgoing owner with no role.** That is correct while the column exists and must be resolved before it is dropped.

Groomer, Receptionist and Manager survive as the names 0041 gave the roles it seeded, and as invitation seed templates. Preset names are still never used for server authorization: a role seeded from a preset stores that preset's permission array, and authorization reads the array.

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
