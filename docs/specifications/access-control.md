# Access-control specification

- A global user accesses a business only through an active membership.
- An employee is a business-owned operational profile and may have no login.
- The owner always has every business permission. Presets only initialize
  non-owner permission toggles.
- Every protected HTTP operation resolves user, business, membership, owner
  status, and permissions from the server-side session.
- A non-owner cannot change membership permissions, transfer ownership, or gain
  protected owner authority.
- The last active owner cannot be removed, disabled, or demoted. PostgreSQL
  enforces this invariant in addition to application checks.
- Tenant-owned queries include the resolved business context. Row-level policies
  supply database defense in depth, including direct-role validation in CI.
- Platform support uses exact identifiers, requires an explicit administrator
  identity, and audits access-changing actions with a reason.
