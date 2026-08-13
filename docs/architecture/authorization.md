# Authorization

Owners have protected full authority. Non-owner memberships contain explicit permissions, optionally initialized from Groomer, Receptionist, or Manager presets. Preset names are never used for server authorization.

Every protected route resolves the session and verifies active user, membership, and business state. A requested business identifier is accepted only if the authenticated user has an active membership in that business. Mutation routes enforce the relevant permission on the server.

The final active owner cannot be removed or stripped of ownership by normal updates. PostgreSQL row policies provide tenant defense in depth for tenant-owned tables.

Personal account data is separate from tenant and employee data. The `users`
record owns login email, password credentials, and the user's display name;
`business_memberships` owns workspace access and permissions; and an optional
`employees` record owns operational scheduling identity. `/api/me` presents the
authenticated account and current membership without exposing credential or
session internals. Users may update only their own display name. Login email is
read-only, and role, permissions, and business identity remain controlled by
workspace authorization flows. An authenticated password change verifies the
current password and revokes the user's other active sessions.
