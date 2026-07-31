# ADR-004: Pet Care document storage and request recovery

Status: Accepted for D3.2 implementation

Pawsh stores pet-document lifecycle and authorization metadata in PostgreSQL and immutable PDF bytes in private object storage. Production and staging use an S3-compatible adapter backed by the AWS SDK. Development may use an explicitly selected atomic filesystem adapter, and tests use an isolated in-memory adapter. Production-like environments reject filesystem or missing storage configuration at startup.

Each upload creates a committed `pending` metadata row with a unique, server-generated, non-overwritable storage key. Promotion to `current` occurs only after upload completion, promotion-time authorization, stable pet-row locking, and current-document/pet-version revalidation. Replacements create new document identities and preserve the last known-good current document on every failure.

A separate durable request record scopes `uploadRequestId` by business, pet, and operation. Its canonical fingerprint contains only pre-upload metadata; an optional client-claimed digest is untrusted and verified against the server-computed SHA-256. Mutation endpoints never restart completed or in-progress requests. A fileless status endpoint is the recovery mechanism after response loss.

Request outcomes are `in_progress`, `completed`, `failed`, or `conflict`. Failed and conflict outcomes are terminal for that request identifier. Pending document cleanup and request retention are separate policies. The initial operational defaults are a one-hour pending threshold and seven-day request retention, both configurable and subject to review before General Availability.

The MVP accepts PDFs up to 10 MiB using bounded multipart processing, signature and trailing EOF sanity checks. These checks are not malware scanning or comprehensive PDF validation. Downloads are server-mediated, attachment-only, full-response HTTP 200 operations with current authorization checks.

Repository validation proves adapter selection, application lifecycle, error mapping, and provider calls through controlled tests. Staging must separately validate the deployed bucket, IAM, encryption, versioning, lifecycle, regional configuration, credentials, and recovery behavior.
