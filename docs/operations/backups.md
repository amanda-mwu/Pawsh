# Backups and recovery

Production classification requires managed PostgreSQL automated backups, daily snapshots, point-in-time recovery where available, encrypted storage, and at least 30 days retention unless the business retention policy requires otherwise.

Restore procedure:

1. Declare the incident and prevent writes to the affected environment.
2. Select the latest verified recovery point before the incident.
3. Restore to a new database instance.
4. Run schema and integrity checks without modifying the source backup.
5. point staging at the restored copy and execute the canonical smoke flow.
6. Record data-loss window and validation evidence.
7. Switch production only after authorization and retain the prior instance for investigation.

The CI workflow performs a real PostgreSQL custom-format dump, restores it into a
new database, and verifies that its public-table inventory and row counts match
the source without mutating the restored copy. Managed production backup
retention and point-in-time recovery still require validation
in the selected hosting environment.

Pet Care PDF bytes live outside PostgreSQL. Database backup and restore protects
document metadata only. The object provider needs an independent versioning,
retention, and recovery contract, followed by metadata/object reconciliation.
Actual bucket recovery remains a staging gate.

Local development data is disposable and is not part of the production backup
contract. No production backup or production-derived dump is needed for local
setup or automated tests. Native and Docker parity environments use migrations
and synthetic seed data; CI restore rehearsal remains authoritative for the
repository-level PostgreSQL backup contract.
