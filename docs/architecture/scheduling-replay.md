# Scheduling durable replay

## Scope and transport

E3 protects only `appointment.create` and `appointment.reschedule`. Both require
an `Idempotency-Key` header containing 16–128 ASCII letters, digits, hyphens, or
underscores. The browser normally uses `crypto.randomUUID()`. Keys are scoped by
business and operation, are never derived from scheduling data, and are not
written to application logs.

Create requires `appointments.create`; reschedule requires `appointments.edit`.
A replay additionally requires current `appointments.view`. A replay whose
committed result applied conflict override requires current
`appointments.override_conflict`; an availability-override result requires
current `appointments.edit`. An authorized actor in the same business may replay
another actor's request, but the initiating actor and original audits never
change.

## Canonical intent

The hash envelope is a fixed ordered tuple containing operation,
canonicalization version, and normalized logical fields. Create v1 includes
location, customer, pet, employee, sorted unique service IDs, E1 local wall
time/disambiguation, expected location version, both override intents and
reason, and notes. Omitted/null optional values are equivalent; empty notes are
distinct because the mutation stores them distinctly. Reschedule v1 includes
appointment and expected version, target employee, local wall time/
disambiguation, expected location version, override intents, and reason.

Service order has no existing persisted business meaning: the current catalog
query and snapshot insertion do not preserve request order. Sorting unique IDs
therefore makes reordered equivalent selections replay-compatible.

## Claim and transaction

After authentication, operation authorization, key/input validation, and hash
construction, the route begins one PostgreSQL transaction and executes
`INSERT ... ON CONFLICT DO NOTHING RETURNING id`. A returned row owns the claim.
No row causes an indexed tenant/operation/key read after PostgreSQL resolves the
concurrent insertion. Matching completed intent returns its immutable result;
mismatched intent returns `IDEMPOTENCY_KEY_REUSED`.

New claims retain all E1/D1 location, advisory-lock, availability, conflict,
trigger, audit, and outbox work in the same transaction. Every business or
infrastructure failure throws through the transaction boundary, rolling back
the claim with the mutation and success events. A failed uncommitted key may be
used again; changed payload after such a rollback is a new request because no
durable identity exists. There is no committed in-progress state or recovery
worker.

## Result and retention

Typed result columns preserve schema version, appointment ID/version, UTC
interval, E1 timezone/local/offset/disambiguation evidence, employee/location,
availability override, and the complete conflict-override response outcome.
They deliberately exclude notes and duplicated customer/pet/service data. A
database trigger prevents update or deletion after completion. Replays map the
recognized logical schema to the supported API response and never read current
appointment state. Hard appointment deletion is not supported; terminal records
remain replayable subject to current authorization.

Records have a one-year `minimum_retain_until` governance floor and are not
automatically deleted during the controlled pilot. The pilot starts at human
launch approval and ends at the recorded pilot closure decision. The Operations
owner defined by GOV-001 owns post-pilot review; the named human remains pending
while GOV-001 is open. A provisional diagnostic envelope of one business, 100
creates and 50 reschedules daily for 90 days yields 13,500 rows; actual
qualification awaits approval. Cleanup/archive/tombstone design is post-pilot.

