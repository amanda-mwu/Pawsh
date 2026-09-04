# Scale readiness

This record tracks architecture assumptions and promotion triggers. It is not QA
PASS evidence.

## Controlled-pilot data envelope

These values are **Provisional Engineering Assumptions**, established
2026-07-30. They use the deliberately limited pilot scope and the existing
seven-day calendar objective as their rationale. Product owner approval is
pending. Review is required before staging enrollment, when any value is
exceeded, or when the pilot scope changes.

| Dimension | Planning value |
| --- | ---: |
| Pilot tenants | 3 |
| Employees per tenant | 10 |
| Services per tenant | 30 |
| Active customers per tenant | 2,000 |
| Pets per tenant | 3,000 |
| Appointments per tenant/day | 70 |
| Retained appointment history | 2 years / approximately 51,000 per tenant |
| Invoices per tenant | 50,000 retained |
| Payment events per tenant | 60,000 retained |
| Audit events per tenant/day | 500 |
| Concurrent active users/sessions per tenant | 20 |

The D1 diagnostic dataset `d1-pilot-v1` contains 525 appointments in one
seven-day query window, deliberately slightly above the 490-appointment planning
value. It is isolated to the database scheduling regression suite and does not
inflate ordinary browser fixtures.

## Findings

### TIME-005 — Cross-midnight scheduling scope

- Evidence: weekly business/employee hours model one same-local-day interval;
  safely covering an appointment across two local dates requires a different
  availability evaluation contract.
- Severity/current impact: no confirmed controlled-pilot requirement for
  overnight grooming; accepting it accidentally would create correctness risk.
- Disposition: Accepted Controlled-Pilot Limitation.
- Promotion trigger: any pilot location requiring overnight hours or an
  appointment crossing local midnight.
- Status: E1 rejects cross-midnight appointments and start-after-end weekly
  rows; explicit date-aware support is deferred.

### DB-001 — Override-aware conflict serialization

- Evidence: the original unconditional exclusion constraint could not represent
  intentional authorized overlap.
- Severity/current impact: correctness blocker for the pilot override contract.
- Disposition: Must Fix Current D Batch.
- Promotion trigger: immediate.
- Status: Resolved in D1 with per-business/employee transaction locks, a fresh
  overlap read, an appointment-specific transaction permit, and a database
  trigger covering occupancy-field writes.

### SEC-001 — Dedicated conflict-override authority

- Evidence: the existing availability override used owner or
  `appointments.edit`; no conflict-specific capability existed.
- Severity/current impact: security blocker for explicit conflict override.
- Disposition: Must Fix Current D Batch.
- Promotion trigger: immediate.
- Status: Resolved with `appointments.override_conflict`, current membership
  revalidation, tenant checks, explicit intent, and atomic override audit.

### ARCH-001 — Booking request replay keys

- Evidence: appointment creation and rescheduling do not accept a durable
  idempotency key. UI pending-state protection prevents ordinary duplicate
  interaction, and normal exact overlap is conflict-safe, but transport replay
  has no general payload-bound response contract.
- Severity/current impact: no demonstrated D1 correctness failure in the current
  browser; an explicitly retried authorized override could create another
  intentional booking.
- Disposition: Must Fix Before Controlled Pilot.
- Promotion trigger: release-candidate staging automation or introduction of an
  API/mobile client that automatically retries mutations.
- Status: Resolved in E3 with tenant/operation/key uniqueness, versioned E1
  wall-time canonicalization, atomic claim/mutation/audit/outbox/result commits,
  immutable historical replay results, current replay authorization, and
  concurrent commit/rollback plus response-loss coverage. Pilot records are
  retained without automatic deletion; post-pilot archival is reviewed after
  GOV-001 establishes the actual envelope.

### ARCH-007 — Financial mutation durable idempotency

- Evidence: invoice creation, manual payment recording, and manual payment void
  previously depended on UI pending state and resource locks without a durable
  payload-bound replay result.
- Severity/current impact: duplicate transport execution could create a second
  manual payment even though invoice uniqueness protected invoice creation.
- Disposition: Must Fix Current D4.
- Promotion trigger: immediate.
- Status: Resolved in D4 with tenant/operation/key uniqueness, operation-specific
  canonical hashes, atomic financial/audit/outbox/result transactions, current
  replay authorization, response-loss coverage, and 30-day retention.

### LAT-001 — Calendar query pilot envelope

- Evidence: the calendar endpoint is tenant- and start-range-bounded, performs
  one grouped appointment query, and orders by start, employee, and appointment
  ID. `d1-pilot-v1` records response size, elapsed time, and
  `EXPLAIN (ANALYZE, BUFFERS)` in PostgreSQL CI.
- Severity/current impact: diagnostic; no unbounded calendar-history read.
- Disposition: Accepted / Documented Current Limitation.
- Promotion trigger: pilot p95 approaches the documented one-second objective,
  payload exceeds operationally reasonable size, or the 70 appointments/day
  envelope is exceeded.
- Status: Monitored.

### SCALE-001 — Process-local authentication throttling

- Evidence: authentication counters reside in application memory.
- Severity/current impact: none with one serving instance.
- Disposition: Must Fix Before Horizontal Scaling.
- Promotion trigger: deployment of more than one independently serving
  application instance.
- Status: Open.

### SCALE-002 — Database connection budget

- Evidence: the application pool maximum is 10 connections per process; the
  migration process uses one additional connection. PostgreSQL's deployed
  connection ceiling is environment-owned and not yet recorded here.
- Severity/current impact: none for the single-instance pilot assumption.
- Disposition: Must Fix Before Horizontal Scaling.
- Promotion trigger: more than one app instance or a separately scaled worker.
- Status: Open; model `instances × 10 + workers + migration/operations` before
  promotion.

### SCALE-003 — Background claim safety

- Evidence: outbox and notification workers claim bounded rows with
  `FOR UPDATE SKIP LOCKED`; notification delivery attempts have an idempotency
  identity and concurrent-worker database coverage.
- Severity/current impact: no known correctness issue.
- Disposition: Accepted / Documented Current Limitation.
- Promotion trigger: external provider integration whose idempotency guarantees
  differ, or worker throughput exceeds current bounded batches.
- Status: Current multi-worker database claiming is validated; operational
  backlog monitoring remains a pre-pilot observability task.

### GOV-001 — Pilot envelope approval

- Evidence: product-approved pilot volumes are not yet recorded.
- Severity/current impact: engineering query conclusions currently rely on the
  provisional envelope above.
- Disposition: Must Fix Before Controlled Pilot.
- Promotion trigger: before staging/pilot enrollment.
- Status: Product owner approval pending.

### UX-002 — Stale lifecycle reconciliation

- Evidence: lifecycle errors previously displayed an error while leaving the
  appointment controls rendered from stale client state.
- Severity/current impact: operational correctness and repeated-action risk.
- Disposition: Must Fix Current D Batch.
- Promotion trigger: immediate.
- Status: Resolved in D2 by preserving handled error feedback and refreshing
  authoritative application state without a full browser reload.

### ARCH-002 — Optional lifecycle version

- Evidence: lifecycle requests may omit `version`; supplied stale versions
  return 409, while omitted versions rely on row locking and current-state
  transition validation.
- Severity/current impact: no integrity defect; omitted-version repeats are
  rejected with 400 after the row lock.
- Disposition: Accepted / Documented Current Limitation.
- Promotion trigger: a public/mobile API contract requires mandatory optimistic
  concurrency across mutations.
- Status: Current optional contract retained and validated in D2.

### GOV-002 — Lifecycle event-time authority

- Evidence: appointments have general `created_at` and `updated_at`, but no
  dedicated lifecycle milestone columns.
- Severity/current impact: no current operational-history gap; audit and outbox
  records preserve attributable transition times.
- Disposition: Accepted / Documented Current Limitation.
- Promotion trigger: actual-duration, labor-productivity, SLA, or
  dispute-timeline reporting requires milestone columns.
- Status: Event-time authorities documented in D2; dedicated columns deferred.

### ARCH-003 — No-show domain event

- Evidence: no-show writes `appointment.no_show` audit history but intentionally
  emits no outbox event; no current worker or pilot workflow consumes one.
- Severity/current impact: none under the current product contract.
- Disposition: Accepted / Documented Current Limitation.
- Promotion trigger: introduction of downstream no-show messaging, reporting,
  or integration behavior.
- Status: Outbox N/A contract documented and validated in D2.

### SEC-002 — Pet safety view and edit boundaries

- Evidence: customer history returned complete pet rows to `customers.view`,
  and the general pet update accepted safety fields under `pets.edit`.
- Severity/current impact: pilot-blocking disclosure and unauthorized mutation.
- Disposition: Must Fix Current D Batch.
- Promotion trigger: immediate.
- Status: Resolved in D3 with shared protected-field redaction and separate
  profile/care operations. D3.1 superseded the authorization names with
  `pets.care.view` and `pets.edit` + `pets.care.edit`; no compatibility alias
  remains.

### ARCH-005 — Stale pet replacement

- Evidence: unversioned full replacement could overwrite a newer safety warning.
- Severity/current impact: pilot-blocking safety-data integrity risk.
- Disposition: Must Fix Current D Batch.
- Promotion trigger: immediate.
- Status: Resolved in D3. Every pet update requires a positive current version;
  stale conditional updates return 409 without partial writes.

### GOV-004 — Current versus snapshot history

- Evidence: history joins current customer, pet, and employee identity, while
  appointment service facts are booking-time snapshots.
- Severity/current impact: misleading historical claims if undocumented.
- Disposition: Must Fix Current D Batch through documentation and validation.
- Promotion trigger: immediate.
- Status: Resolved in D3. Service-time identity and safety snapshots remain
  explicitly absent.

### SEC-DOC-001 — No dedicated PDF malware scanning (OPEN)

**This entry is the authoritative status of SEC-DOC-001. Where any other
document disagrees with it, this one governs.**

- Evidence: uploads are restricted to bounded PDFs with shallow signature/EOF
  checks, private storage, permission-controlled attachment downloads, and no
  Pawsh inline rendering. Nothing scans or sanitizes active PDF content.
- Severity/current impact: a hostile PDF could reach an authorized staff
  browser or device PDF handler.
- Disposition: **Must Fix Before Controlled Pilot.**
- Promotion trigger: before any pilot user can upload or download Pet Care PDFs.
- Status: **OPEN.**

#### A superseded design is not a closed finding

ADR-010 supersedes the *runtime scanning design* recorded in ADR-005. **It does
not, by itself, close SEC-DOC-001, and it is not closure evidence for it.**

The finding describes a residual risk — an allowed PDF may carry malicious
content nothing inspects — and that risk survived the architectural replacement
that removed its original control. Superseding an implementation retires the
implementation; it does not retire the risk the implementation existed to
address. The current control is different from the one ADR-005 specified, and
the finding is open against whatever control is actually in place.

**ADR-005's asynchronous scanner, quarantine queue, retries, dead letters and
scanner monitoring are superseded and are NOT required.** Nothing here asks for
them to be rebuilt. The MVP control is the Rabies Attachment Minimum Safety set
described in ADR-010, and SEC-DOC-001 is open against that set.

#### What closes SEC-DOC-001

Both of the following, and neither alone:

1. **Staging evidence** that the replacement control meets what the applicable
   release-governance process requires of it. What that evidence must consist of
   is set by that process, not by this entry, and not by the superseded ADR-005
   design.
2. **An explicit recorded closure** of the finding by Security together with the
   launch approver, naming the evidence relied on.

Until both exist, SEC-DOC-001 is open and blocking for the controlled pilot.
Shallow sanity validation is not represented as malware scanning and does not
constitute closure evidence.

### ARCH-DOC-001 — Buffered document ingestion

- Evidence: Fastify enforces a 10 MiB limit and the application holds one
  bounded PDF buffer while hashing and storing it. The pilot assumption is at
  most two concurrent uploads per instance.
- Severity/current impact: approximately 20 MiB plus framework/SDK overhead at
  the provisional envelope; no unbounded allocation path.
- Disposition: Accepted / Documented Current Limitation.
- Promotion trigger: more than two concurrent uploads per instance, a larger
  file limit, memory pressure, or horizontal instance scaling.
- Status: Monitored; move to streaming when evidence promotes it.

### GOV-DOC-001 — Superseded evidence retention

- Evidence: current and superseded rabies records are retained until an approved
  care-document retention schedule exists.
- Severity/current impact: preserves evidence but creates storage/privacy growth
  without a final deletion schedule.
- Disposition: Must Fix Before General Availability.
- Promotion trigger: GA planning or adoption of a formal retention policy.
- Status: Engineering owner; review by 2026-10-31. Reconciliation cannot delete
  current or superseded evidence.
