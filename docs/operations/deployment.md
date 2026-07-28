# Deployment

1. Install from the lockfile.
2. Inject validated runtime configuration.
3. Back up the database and review the forward migration.
4. Apply migrations once.
5. Run lint, types, unit tests, database tests, and build.
6. Deploy the application artifact.
7. Verify `/health`, authentication, tenant denial, scheduling, and checkout smoke paths.
8. Monitor errors, latency, outbox backlog, and notification failures.

If migration or smoke validation fails, stop rollout. Prefer a forward repair migration. Restore the database only for material corruption and follow the recovery procedure.
