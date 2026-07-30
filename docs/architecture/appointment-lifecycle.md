# Appointment lifecycle

## Capability matrix

| Source | Action | Target | Permission | Success | Invalid/repeat | Supplied stale version | Audit | Outbox | Analytics | Capacity |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |
| `scheduled` | Check in | `checked_in` | `operations.check_in` | 200 | 400 | 409 | `appointment.checked_in` | `AppointmentCheckedIn` | N/A | Remains blocking |
| `checked_in` | Start service | `in_service` | `operations.perform_service` | 200 | 400 | 409 | `appointment.in_service` | `AppointmentStarted` | N/A | Remains blocking |
| `in_service` | Complete | `completed` | `operations.complete` | 200 | 400 | 409 | `appointment.completed` | `AppointmentCompleted` | `AppointmentCompleted` | Becomes nonblocking |
| `scheduled` | Cancel | `cancelled` | `appointments.cancel` | 200 | 400 | 409 | `appointment.cancelled` | `AppointmentCancelled` | N/A | Becomes nonblocking |
| `scheduled` | No-show | `no_show` | `appointments.cancel` | 200 | 400 | 409 | `appointment.no_show` | N/A | N/A | Becomes nonblocking |

`completed`, `cancelled`, and `no_show` are terminal. Reopen is absent and
deferred. Missing permission returns 403. An appointment missing from the
authenticated tenant scope returns 404.

No-show intentionally has no outbox event: the current pilot product has no
downstream no-show consumer. Its append-only audit event is the authoritative
business record. Add a domain event only when a concrete downstream contract
exists.

## State authority and concurrency

The API accepts an optional expected `version`. When supplied, a mismatch
returns 409 before transition validation. When omitted, correctness still comes
from the tenant-scoped appointment row lock and validation of the current
database state; an invalid/repeated transition returns 400. Version is a
stale-client diagnostic and concurrency contract, not the sole integrity
mechanism.

The transition transaction:

1. authenticates the current session and membership;
2. checks the action-specific capability;
3. enters a tenant-scoped transaction;
4. locks and reads the appointment row with `FOR UPDATE`;
5. acquires the D1 business/employee scheduling advisory lock;
6. validates supplied version and the state-machine edge;
7. commits state, audit, and documented outbox/analytics effects atomically.

Tests synchronize concurrent callers immediately before row-lock acquisition.
PostgreSQL then serializes both callers through the production lock path.

## D1 capacity interaction

`scheduled`, `checked_in`, and `in_service` consume employee capacity.
`completed`, `cancelled`, and `no_show` do not. Every transition acquires the
same employee scheduling lock used by D1, and the database conflict trigger
covers status changes. A completion-versus-booking race therefore resolves
according to scheduling-lock order rather than stale application observations.

## Event time

Dedicated lifecycle timestamp columns are deferred for the controlled pilot.
They are not inferred from `appointments.updated_at`.

- `audit_events.created_at` is the authoritative recorded transition time.
- `outbox_events.occurred_at` is durable domain-event creation time.
- `outbox_events.processed_at` is worker processing time, not transition time.
- `appointments.updated_at` is only the latest appointment mutation time.

This is sufficient for the current operational history. Dedicated milestone
timestamps must be reconsidered before actual-duration, labor-productivity,
SLA, or dispute-timeline reporting relies on appointment rows directly.

## UI reconciliation

Lifecycle actions wait for the server result. Modal submission is disabled while
pending, and completion uses a per-appointment single-flight guard plus a
disabled action. A handled stale-version or invalid-state result preserves an
understandable error and refreshes authoritative application state, removing
obsolete controls without a full page reload.

The current refresh is a bounded application refresh. Targeted appointment
refresh remains an optimization only if pilot latency measurements demonstrate
material impact.
