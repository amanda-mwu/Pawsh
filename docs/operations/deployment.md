# Deployment

Production authority is a containerized Pawsh artifact or managed container
platform connected to managed PostgreSQL 17, managed object storage, managed
secrets, monitoring, encrypted automated backups, and point-in-time recovery.
Staging mirrors configuration, permissions, authentication, storage, scanner,
backup, monitoring, and topology where behavior depends on them; it need not
match production scale.

Database credentials are separated by function: provisioning administration,
migration/schema ownership, non-owner runtime without `BYPASSRLS`, and bounded
read-only reporting. Each process receives its own credential through
`DATABASE_URL`; the runtime credential must not migrate or own protected tables.
Final role grants and managed-provider enforcement remain a staging validation
gate and must not be inferred from local developer ownership.

1. Install from the lockfile.
2. Inject validated runtime configuration.
3. Back up the database and review the forward migration.
4. Apply migrations once.
5. Run lint, types, unit tests, database tests, and build.
6. Deploy the application artifact.
7. Verify `/health`, authentication, tenant denial, scheduling, and checkout smoke paths.
8. Monitor errors, latency, outbox backlog, and notification failures.

If migration or smoke validation fails, stop rollout. Prefer a forward repair migration. Restore the database only for material corruption and follow the recovery procedure.
