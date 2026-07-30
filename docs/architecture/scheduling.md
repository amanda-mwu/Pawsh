# Scheduling

## D1 capability model

| Capability | Implemented | Pilot required | D1 required | Semantics |
| --- | --- | --- | --- | --- |
| Create appointment | Yes | Yes | Yes | Creates one scheduled appointment with immutable service name, duration, and price snapshots |
| Reschedule appointment | Yes | Yes | Yes | Identity-preserving move of a scheduled appointment with optimistic version checking |
| Cancel appointment | Yes | Yes | Yes | Terminal `scheduled` → `cancelled` transition; the record remains historical and stops reserving capacity |
| Employee availability | Yes | Yes | Yes | Business hours, employee hours, employee blocked time, active employee, and service eligibility |
| Appointment conflict detection | Yes | Yes | Yes | Half-open overlap protection for the same employee in a blocking status |
| Appointment conflict override | Yes | Yes | Yes | Explicit request by a caller with `appointments.override_conflict`; never inferred from role or permission alone |
| Availability override | Yes | Yes | Yes | Separate existing override for hours/blocked-time availability; requires an explicit reason |
| Duplicate UI submission protection | Yes | Yes | Yes | The active form submit is disabled until its mutation settles |
| Request idempotency key | No | Not yet | No | Deferred before Controlled Pilot; ordinary exact overlap is conflict-safe, but the API has no general replay-key contract |

## Authoritative model

The capacity-constrained resource is an employee within a business. Different
employees may work simultaneously. For one employee, appointments in
`scheduled`, `checked_in`, or `in_service` reserve the half-open interval
`[start_at, end_at)`. Adjacent intervals do not conflict. `completed`,
`cancelled`, and `no_show` appointments are nonblocking historical records.

Appointment services snapshot their name, duration, and price. Creating an
appointment sums the selected duration snapshots. Editing services before
checkout replaces those snapshots and recomputes the appointment end time.
Existing service-catalog edits do not retroactively move appointments.

Appointments persist UTC instants in `timestamptz`. APIs accept offset-bearing
timestamps. Availability interprets those instants in the location's IANA
timezone; the browser presents them in its configured local timezone. Exhaustive
DST ambiguity policy remains part of the later calendar/time validation.

Cancellation is a terminal audited state transition, not deletion. Rescheduling
updates the same scheduled appointment. A failed or stale move leaves its
original resource and interval unchanged.

## Conflict and override transaction

Every occupancy-changing application path takes a transaction-scoped PostgreSQL
advisory lock keyed by `hashtextextended(business_id || ':' || employee_id, 0)`.
Cross-employee moves acquire both keys in sorted employee-ID order. After the
lock, the transaction reads current blocking appointments using the same
half-open interval semantics.

Normal conflicts return `409` with code `SCHEDULING_CONFLICT`, safe conflicting
intervals, and server-computed `canOverride`. A conflict does not mutate state.

An explicit `overrideConflict: true` request first requires ordinary scheduling
authority and current server-side `appointments.override_conflict` authority.
If a conflict exists, the transaction installs an appointment-specific local
permit, writes the mutation, and writes `appointment.conflict_override` audit
history atomically. If no conflict exists, the mutation is ordinary:
`overrideApplied` is false and no override audit is written.

The database trigger `employee_appointment_conflict_guard` participates in every
insert and occupancy-field update as defense in depth. It permits overlap only
when the transaction-local permit exactly matches the affected appointment ID.
The persisted `conflict_overridden` flag is presentation metadata and never
exempts a future mutation from conflict checking.

Create, reschedule, cancellation/status changes, and service-duration updates
all use the coordination path directly or through the database trigger.

## Audit and outbox

Ordinary create, move, and cancellation retain their existing business audit
and outbox contracts. A successful conflict override adds exactly one
`appointment.conflict_override` audit event in the mutation transaction. It
identifies the actor, employee, interval, operation, and conflicting appointment
IDs without copying customer or pet details. Conflict override itself does not
create an additional outbox event.
