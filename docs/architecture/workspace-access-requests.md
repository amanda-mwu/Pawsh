# Existing workspace access requests

An access request is not a membership. An unauthenticated person submits their
name, email, exact workspace name, workspace administrator email, and an
optional bounded message. Pawsh always returns the same accepted response, so
the public endpoint does not disclose whether a workspace, administrator, user,
or membership exists. Matching requires an exact workspace and authorized
administrator contact; pending requests are unique by tenant and normalized
requester email and are rate limited.

The durable request is tenant scoped and auditable. Active Owners and members
with `team.manage` receive a notification intent and can review requests only
inside Salon Setup. Approval never accepts a role from the requester. An
existing Pawsh user receives the `groomer` permission preset in the requested
workspace; a person without an account receives the existing expiring secure
membership invitation. Rejection records the reviewer and timestamp. Both
decisions create audit/outbox evidence.

Sessions select one authorized workspace through `sessions.business_id`.
Users with multiple active memberships can switch to another membership from
Profile & Account; the server verifies that membership before changing the
session. Authentication and every tenant query continue to derive workspace
authority from the server-side session and membership, never browser-supplied
role or permission data.
