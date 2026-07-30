# Appointment workflow specification

An MVP appointment belongs to one business and location, customer, pet, and
primary employee, and contains one or more immutable service name, duration, and
price snapshots.

Valid operational transitions are:

- `scheduled` to `checked_in`, `cancelled`, or `no_show`
- `checked_in` to `in_service`
- `in_service` to `completed`

Completed, cancelled, and no-show appointments do not reopen through the normal
workflow. Invalid transitions are rejected server-side and state changes are
audited.

The formal permission, HTTP, repeat, event, concurrency, and event-time
contracts are maintained in `docs/architecture/appointment-lifecycle.md`.

Scheduled, checked-in, and in-service appointments reserve `[start_at, end_at)`.
Serialized PostgreSQL transactions prevent accidental overlapping employee
reservations under concurrent creates, moves, reassignments, and duration
changes. An explicit conflict override requires current
`appointments.override_conflict` authority and an atomic audit entry.
Availability is a separate check against business hours, employee hours, and
blocked time; its existing override requires an explicit reason.

Appointment views used for check-in and service execution expose pet safety
alerts, medical and behavioral notes, grooming preferences, services, and
appointment notes.
