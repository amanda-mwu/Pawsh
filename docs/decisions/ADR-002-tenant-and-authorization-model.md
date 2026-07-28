# ADR-002: Tenant and authorization model

Status: Accepted

Every operational record has an explicit `business_id`. An authenticated request resolves its business membership on the server. Owners have protected full authority; non-owners receive explicit permission strings, optionally initialized from presets.

Application authorization is authoritative. PostgreSQL row-level policies provide defense in depth using a transaction-local `app.business_id`. Storage, jobs, reports, and notifications must carry the same tenant identity.

Users, memberships, and employees remain separate. Employees may exist without login access, and memberships need not represent service providers.
