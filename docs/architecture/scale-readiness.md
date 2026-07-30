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
- Status: Open.

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
