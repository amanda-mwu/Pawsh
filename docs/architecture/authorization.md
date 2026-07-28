# Authorization

Owners have protected full authority. Non-owner memberships contain explicit permissions, optionally initialized from Groomer, Receptionist, or Manager presets. Preset names are never used for server authorization.

Every protected route resolves the session and verifies active user, membership, and business state. A requested business identifier is accepted only if the authenticated user has an active membership in that business. Mutation routes enforce the relevant permission on the server.

The final active owner cannot be removed or stripped of ownership by normal updates. PostgreSQL row policies provide tenant defense in depth for tenant-owned tables.
