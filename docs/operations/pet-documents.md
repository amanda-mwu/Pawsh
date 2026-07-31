# Pet Care document operations

Pawsh stores Pet Care document metadata in PostgreSQL and immutable PDF bytes in private object storage. The first supported type is `rabies_vaccination`; PDFs are limited to 10 MiB and delivered as attachments.

## Storage configuration

`DOCUMENT_STORAGE_ADAPTER` is mandatory. Production accepts only `s3`, tests accept only `memory`, and development may explicitly select `filesystem`. S3 requires `DOCUMENT_STORAGE_BUCKET` and `DOCUMENT_STORAGE_REGION`; `DOCUMENT_STORAGE_ENDPOINT` supports a compatible private service. Static access keys are optional and must be supplied as a pair; workload credentials are preferred. S3 uploads request AES-256 server-side encryption, conditional create-only writes, two bounded SDK attempts, a five-second connection timeout, and a thirty-second request timeout.

Repository validation covers configuration and adapter behavior. Staging must verify the actual bucket, IAM, credentials, encryption, versioning, lifecycle, region, redundancy, and restore behavior.

## Lifecycle and recovery

PostgreSQL states are `pending`, `current`, and `superseded`. Only explicit `state = 'current'` metadata is operational authority. Current and superseded objects are never removed by the MVP reconciliation command.

Pending documents older than one hour are eligible for reconciliation. Durable upload-request records are retained for seven days, independently of pending cleanup. Engineering owns these defaults; review is required before General Availability, when uploads routinely exceed ten minutes, or when retry/support evidence shows seven days is insufficient.

Dry-run a tenant-scoped batch:

```text
npm run documents:reconcile -- --tenant=<business-uuid> --batch=25
```

Apply only after reviewing the exact IDs:

```text
npm run documents:reconcile -- --tenant=<business-uuid> --batch=25 --apply
```

`--all-tenants` is an explicit administrative alternative. The command rechecks pending state, emits a non-sensitive cleanup audit, is bounded to 100 rows, and fails when storage inspection fails. Missing/mismatched current objects are integrity incidents and are never automatically deleted or rewritten.

## Capacity assumptions

The provisional pilot model assumes a 2 MiB average PDF, a 10 MiB maximum, one current plus three superseded records per pet, two concurrent uploads per application instance, and at most 3,000 documents across the initial pilot. Multipart handling buffers at most one 10 MiB PDF per request. Two maximum-size uploads therefore reserve about 20 MiB plus framework/SDK overhead.

Previous Records is ordered by creation time and ID descending. Pagination is promoted if one pet exceeds 100 records or a history response exceeds 1 MiB.

## Backup and security boundaries

PostgreSQL backup protects metadata and request identity, not PDF bytes. Provider versioning, retention, accidental-deletion recovery, and redundancy are intended controls but remain staging-validated facts. Run reconciliation after a PostgreSQL restore.

`pets.care.view` controls metadata/history/download. Upload and replacement require `pets.edit` plus `pets.care.edit`, checked before ingestion and before promotion. Object keys and provider details never appear in ordinary APIs.

PDF checks are deliberately shallow: MIME, byte limit, `%PDF-` at byte zero, and `%%EOF` within 4 KiB. This is not structural validation, sanitization, encryption detection, or malware scanning. `SEC-DOC-001` requires dedicated scanning before Controlled Pilot.
