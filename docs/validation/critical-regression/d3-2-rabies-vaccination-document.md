# D3.2 — Rabies Vaccination PDF

## Classification

**Pet Care Document Management Valid — Rabies Vaccination PDF**.

This extends D3/D3.1 without rewriting their evidence. The final report records
the exact clean green documentation SHA because a commit cannot contain its own
hash.

## Capability matrix

| Capability | Implemented | UI | Pilot required | Status |
| --- | --- | --- | --- | --- |
| Rabies PDF upload | Yes | Yes | Yes | Validated |
| Private S3-compatible adapter | Yes | N/A | Yes | Repository validated; deployment is staging-owned |
| Current metadata/download | Yes | Yes | Yes | Validated |
| Replacement and Previous Records | Yes | Yes | Yes | Validated |
| Structured expiration coordination | Yes | Yes | Yes | Validated |
| Archived historical access | Yes | Yes | Yes | Validated |
| User removal | No | No | No | Deferred |
| OCR/images/reminders/booking enforcement | No | No | No | Deferred |

## Architecture

ADR-004 records the decision. PostgreSQL owns identity, ownership, lifecycle,
request identity, metadata, current selection, expiration, and audit. Object
storage owns immutable bytes only. Every document receives a unique create-only
server key; object existence has no domain authority.

Production/staging uses the implemented AWS SDK S3-compatible adapter. Tests use
isolated memory; development may explicitly select atomic filesystem storage.
Production rejects missing, unknown, memory, and filesystem selection. Actual
bucket privacy, IAM, credentials, encryption, versioning, lifecycle, region,
and recovery remain staging gates.

## Data, version, and concurrency

Migration `0005_pet_documents.sql` adds tenant-owned documents and requests,
composite pet ownership, RLS, partial current uniqueness, deterministic history
indexes, and request uniqueness.

Documents transition `pending → current → superseded`. Evidence is immutable;
replacement creates a new ID with document version 1. Initial promotion locks
the pet and requires no current record. Replacement checks expected current ID
and version. Expiration mutation separately checks pet version. Conflicts return
409 without partial mutation or loss of the last known-good current record.

## Request identity and authorization

The client UUID is scoped by business, pet, and upload/replace operation. Its
fingerprint contains canonical pre-upload metadata. Optional `claimedDigest` is
untrusted and verified; server SHA-256 is authoritative. Mutation and fileless
status endpoints are separate. Compatible completed requests return the original
authorized result without uploading again; in-progress returns 202; incompatible
or terminal reuse returns 409.

Requests are retained seven days. Pending documents become cleanup-eligible
after one hour. Promotion reloads active membership and both permissions, so
revocation during ingestion cannot create or replace evidence.

## PDF and download contract

One `application/pdf` up to 10 MiB is accepted with `%PDF-` at byte zero and an
EOF marker within 4 KiB. This is shallow validation—not sanitization, encryption
detection, or malware scanning. Only synthetic fixtures are used.

Downloads require current `pets.care.view`, verify committed size, return full
HTTP 200 attachments with `nosniff` and `private, no-store`, and do not advertise
or implement ranges. Provider details are absent from APIs and audit.

## Pet Care history

Document `expires_on` is an immutable evidence snapshot; pet
`vaccinationExpiresOn` is current operational data. An actual supplied change
increments pet version once and emits one `pet.care.update`; omitted/unchanged
values do neither. Each document creation/replacement emits one non-sensitive
document audit.

Current and Previous Records use creation time and ID descending. Archived
customers/pets stay outside active search but remain reachable through Archived
Pet Care records with current authorization.

## Recovery, scale, and findings

`npm run documents:reconcile` is dry-run by default, tenant/batch bounded,
rechecks pending state, and cannot delete current or superseded objects. It
expires terminal request identities after seven days. PostgreSQL recovery covers
metadata only; object recovery remains provider/staging-owned.

Pilot assumptions: 10 MiB maximum, 2 MiB average, four retained records per pet,
two concurrent uploads per instance, and 3,000 pilot documents. Buffering is
bounded to one PDF per request. Promote history pagination above 100 records or
1 MiB.

| Finding | Disposition | Status |
| --- | --- | --- |
| Rabies Attachment Minimum Safety (ADR-010) | Required for MVP | Replacement controls validated locally; hosted exact-SHA pending |
| ARCH-DOC-001 — bounded buffering | Accepted current limitation | Monitored |
| GOV-DOC-001 — superseded retention schedule | Must Fix Before GA | Open |

## Validation evidence

- Mapping: three focused `@regression-pet-documents` tests; retries 0.
- Static/unit/build/dependency audit: PASS.
- PostgreSQL runtime, migrations, ownership, true concurrency, and backup/restore: PASS.
- Chromium regression: 20 PASS, including the three focused D3.2 scenarios.
- Chromium smoke/security/cross-browser, Firefox/WebKit cross-browser,
  iPhone security, and iPhone/Android/iPad responsive suites: PASS.
- Diagnostic environment: CI PostgreSQL plus deterministic in-memory object
  adapter; application/browser startup excluded; three samples per size.
- 1 MiB: upload median 10.76 ms (10.48–27.52), metadata 1.76 ms,
  download 3.86 ms, history response 771 bytes.
- 5 MiB: upload median 15.57 ms (14.54–28.48), metadata 2.84 ms,
  download 9.57 ms, history response 771 bytes.
- 10 MiB: upload median 23.95 ms (21.79–25.38), metadata 1.85 ms,
  download 18.11 ms, history response 774 bytes.
- No D3.2 pilot-load blocker was confirmed. These diagnostics are evidence,
  not hard performance thresholds, and do not validate real provider latency.

## Closure

- Baseline: `adf1477264b29306c075a0467252dee1461bf019`
- Implementation candidate SHA: `d655769347093b946eb8d149c643f2d7c450e665`
- Candidate CI run: `30653203172` — PASS, all 13 required jobs.
- Final documentation SHA and its exact CI run: recorded in the final Codex
  report (self-reference cannot be embedded in the commit that defines it).
- Repository clean: required and verified at final handoff.

## Known limitations

Deployed provider configuration/recovery remains staging-owned. Dedicated
managed malware scanning is deferred post-MVP by ADR-010. PostgreSQL backup alone does not protect
PDF bytes. Range requests, removal, OCR, images, customer uploads, reminders,
booking enforcement, inline rendering, and generalized document management are
not validated. D4 remains open.
