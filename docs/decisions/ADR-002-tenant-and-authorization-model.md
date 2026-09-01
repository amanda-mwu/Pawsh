# ADR-002: Tenant and authorization model

Status: Accepted

Every operational record has an explicit `business_id`. An authenticated request resolves its business membership on the server. Owners have protected full authority; a non-owner is assigned a **role**, and that role's permissions are the whole of what they may do.

Superseded, 0041/0042: non-owners no longer carry permission strings of their own. Permissions were a flat `text[]` denormalised onto each membership and invitation, so two people doing the same job held two independent copies of the same list and "what may a receptionist do here" had as many answers as there were receptionists. They are now held once, on a role, and a member's role is their only grant — there are no per-member overrides or additions. A role belongs to exactly one business, enforced by a composite foreign key on `(business_id, role_id)` rather than by a route, because the row policies below do not currently enforce anything. A disabled role grants nothing while keeping its assignments.

This deliberately overturns the original note that preset names are never used for server authorization — but only in the narrow sense that Groomer, Receptionist and Manager now survive as role *names*. Authorization still reads a permission array and never a name; a role seeded from a preset stores that preset's array.

Application authorization is authoritative. PostgreSQL row-level policies provide defense in depth using a transaction-local `app.business_id`. Storage, jobs, reports, and notifications must carry the same tenant identity.

Users, memberships, and employees remain separate. Employees may exist without login access, and memberships need not represent service providers.
