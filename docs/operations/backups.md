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

A real restore rehearsal is required before calling the MVP production ready. The local environment used for the initial build did not provide a PostgreSQL engine, so no restore was claimed.
