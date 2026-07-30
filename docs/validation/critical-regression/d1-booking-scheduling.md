# Critical Regression D1 — Booking/Scheduling

## Classification

Critical Regression D1 — Booking/Scheduling Valid.

This closure does not establish Automated Critical Regression Valid. D2
appointment lifecycle, D3 customer/pet history, and D4 checkout/stale-state
error paths remain separate gates.

## Capability matrix

| Capability | Implemented | Pilot required | D1 required | Result |
| --- | --- | --- | --- | --- |
| Create appointment | Yes | Yes | Yes | Validated |
| Reschedule appointment | Yes | Yes | Yes | Validated |
| Cancel appointment | Yes | Yes | Yes | Validated |
| Employee availability | Yes | Yes | Yes | Validated |
| Conflict detection | Yes | Yes | Yes | Validated |
| Explicit conflict override | Yes | Yes | Yes | Validated |
| Availability override | Yes | Yes | Yes | Existing behavior preserved |
| Duplicate UI submission protection | Yes | Yes | Yes | Validated |
| Durable request idempotency key | No | Yes before pilot | No | Deferred as `ARCH-001` |

## Scheduling model

The capacity-constrained resource is an employee within a business. Different
employees may have simultaneous appointments. For one employee, `scheduled`,
`checked_in`, and `in_service` appointments reserve half-open intervals
`[start_at, end_at)`. `completed`, `cancelled`, and `no_show` are nonblocking.

Services are snapshotted onto appointment services. Catalog edits do not move
existing appointments. APIs accept offset-bearing timestamps, persist UTC
instants, and interpret availability in the location IANA timezone. Exhaustive
DST behavior remains a later calendar/time gate.

Cancellation is a terminal audited transition that releases capacity.
Rescheduling preserves appointment identity and is atomic: a rejected move
leaves the original employee and interval unchanged.

## Conflict override contract

Normal overlap returns `409 SCHEDULING_CONFLICT` with caller-safe conflicting
intervals and server-computed `canOverride`. Override requires explicit
`overrideConflict: true`, ordinary scheduling authority, tenant scope, and
current server-side `appointments.override_conflict` authority. Role claims
supplied by a client are not authority.

If no conflict exists, an authorized override request creates an ordinary
booking and returns `overrideApplied: false`; it does not create an override
audit. When a conflict exists, the UI presents an explicit Book/Move anyway
confirmation identifying the employee and intervals. A successful applied
override returns diagnosable scheduling metadata and writes exactly one
`appointment.conflict_override` audit in the mutation transaction.

## Atomic database design

Conflict-sensitive transactions acquire a PostgreSQL transaction advisory lock
for the business/employee key
`hashtextextended(business_id || ':' || employee_id, 0)`. Cross-employee moves
lock employee IDs in deterministic sorted order. After locking, the transaction
revalidates current authority and reads current overlaps.

The `employee_appointment_conflict_guard` trigger covers inserts and
occupancy-field updates. It permits an overlap only when a transaction-local,
appointment-specific permit matches the affected appointment. The persisted
presentation flag never exempts an appointment from later normal conflict
checks. Create, move, cancellation/status, and service-duration mutation paths
therefore participate in the same protection.

## Concurrency evidence

The PostgreSQL scheduling regression suite uses independent authenticated
clients and a barrier immediately before lock acquisition.

- Normal versus normal: one request returns `201`, one handled `409`, and one
  appointment commits.
- Existing plus authorized override: both appointments persist and exactly one
  atomic override audit exists.
- Unauthorized, stale-permission, base-permission-free, and foreign-tenant
  override attempts commit no overlap and no successful override audit.
- Mixed normal/override race produces the serialization-order-valid result:
  either two appointments with one applied-override audit, or one ordinary
  appointment with no override audit.
- Injected post-audit transaction failure rolls back both appointment and audit.
- Cross-employee rescheduling uses deterministic lock order and preserves atomic
  final state.

## Browser validation

The `chromium-regression` project selects exactly nine
`@regression-booking` tests:

1. create and reload persistence;
2. normal conflict and recovery;
3. duplicate-submit protection;
4. authorized create override and dual-calendar rendering;
5. unauthorized direct override;
6. stale override-permission reconciliation;
7. atomic reschedule and reload;
8. authorized conflicting reschedule;
9. cancellation, reload, and released capacity.

CI run
[30580255758](https://github.com/amanda-mwu/Pawsh/actions/runs/30580255758)
passed all nine regression tests with retries set to zero. The inherited
Chromium smoke suite also passed 11/11.

## Pilot envelope and query evidence

The provisional engineering envelope and approval trigger are maintained in
`docs/architecture/scale-readiness.md`. Diagnostic dataset `d1-pilot-v1`
contains 525 appointments in one seven-day window, slightly above the planned
490. It remains separate from browser fixtures.

In PostgreSQL CI, the bounded tenant/date calendar request returned 525
appointments in 466,201 bytes and 25.4 ms endpoint elapsed time. The underlying
ordered query executed in 0.302 ms and used business/date predicates with the
appointment calendar index and stable start/employee/ID ordering. This is
diagnostic evidence, not a performance gate.

## Findings and disposition

| ID | Evidence and impact | Disposition | Trigger/status |
| --- | --- | --- | --- |
| DB-001 | Unconditional exclusion could not support intentional overlap | Must Fix Current D Batch | Resolved by transaction locks, trigger, and scoped permit |
| SEC-001 | No conflict-specific authority existed | Must Fix Current D Batch | Resolved by dedicated permission and atomic audit |
| ARCH-001 | No durable payload-bound replay key | Must Fix Before Controlled Pilot | Open before staging automation or retrying API client |
| LAT-001 | Calendar is bounded at the provisional pilot envelope | Accepted / Documented Current Limitation | Monitor p95, payload, and envelope growth |
| SCALE-001 | Authentication throttle is process-local | Must Fix Before Horizontal Scaling | Before more than one serving instance |
| SCALE-002 | Pool is 10 connections per app process | Must Fix Before Horizontal Scaling | Model deployment connection budget before scaling |
| SCALE-003 | Worker claims use bounded `SKIP LOCKED` claims | Accepted / Documented Current Limitation | Reassess with provider/throughput changes |
| GOV-001 | Pilot envelope is not product-approved | Must Fix Before Controlled Pilot | Approval before staging/pilot enrollment |

## Closure evidence

Implementation candidate:
`9bdb8a184bab28b87433b8b2ccaf306b07049899`

Required CI run:
[30580255758](https://github.com/amanda-mwu/Pawsh/actions/runs/30580255758)

All 13 required jobs passed: static validation; backend/PostgreSQL; backup and
restore; Chromium smoke, regression, security, and cross-browser; Firefox and
WebKit cross-browser; iPhone security; and all three responsive profiles.

The final authoritative SHA is the documentation-containing clean repository
HEAD whose required CI is green. It is recorded in the CI system and final
closure report rather than embedded here, because embedding a commit's own SHA
inside its contents is self-referential.

## Known scope boundary

D1 does not validate appointment lifecycle, customer/pet history, checkout,
full timezone edges, performance gating, staging, manual UX, or physical
devices.
