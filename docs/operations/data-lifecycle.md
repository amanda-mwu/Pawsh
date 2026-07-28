# Data lifecycle

Customers are archived, employees are deactivated, and memberships are disabled. Normal workflows do not hard-delete operational, financial, or audit history.

Business cancellation disables operational access while preserving records for the configured retention period. User removal revokes sessions and memberships but does not erase attributed audit history. Pet/customer anonymization requests require an authorized support procedure that preserves legally required financial records.

Private objects must be tenant-scoped. Orphan cleanup may remove an object only after confirming its metadata is unreferenced within the same tenant. Backup expiry follows backup retention independently from live-data removal.

Exports and deletion/anonymization are controlled support procedures for the MVP and must be authorized, tenant-scoped, and audited.
