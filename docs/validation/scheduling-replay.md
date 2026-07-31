# Scheduling Durable Replay Protection

## Classification

Candidate classification: **Scheduling Durable Replay Protection Valid**.
Final classification requires a clean exact HEAD equal to `origin/main` with all
required CI jobs green. Automated Critical Regression Valid and Calendar & Time
Integrity Valid remain inherited requirements.

## Contract

- Scope: `appointment.create:v1` and `appointment.reschedule:v1` only.
- Transport: required `Idempotency-Key`, 16–128 opaque ASCII token characters;
  browser default `crypto.randomUUID()` with session-scoped uncertain retry.
- Identity: business, operation, and key; actor is attribution only.
- Claim: `ON CONFLICT DO NOTHING RETURNING`, without polling or a committed
  in-progress state.
- Failure: every non-success for a new claim rolls back claim, mutation, audit,
  and outbox. A fully uncommitted key is safely reusable.
- Replay: matching immutable result is evaluated before mutable scheduling
  preconditions. Changed intent returns 409.
- Authorization: current operation, appointment-view, and applicable override
  authority. Same-tenant cross-actor replay preserves original attribution.

## Actual events

Create writes one `appointment.create` audit and `AppointmentCreated` outbox
event. Reschedule writes one `appointment.move` audit and `AppointmentUpdated`
outbox event. Applied conflict override adds one
`appointment.conflict_override` audit and no separate outbox event. Replay adds
none.

## Immutable result and retention

Recognized result schemas are `appointment.create.result:v1` and
`appointment.reschedule.result:v1`. Typed fields retain appointment/version,
UTC interval, E1 time intent, employee/location, and override outcome without
notes or duplicated customer/pet/service data. Later mutations do not change an
old replay. Hard appointment deletion is not exposed.

No automatic deletion occurs during pilot; `minimum_retain_until` defaults to
one year and is a floor. The GOV-001 Operations owner owns post-pilot review;
the named human and approved envelope remain pending. A provisional 90-day
diagnostic envelope at 150 scheduling mutations/day produces 13,500 rows for
one business. No E3 performance threshold is asserted.

## Validation mapping

- Database scheduling regression covers validation, sequential/concurrent
  replay, mismatch, winner rollback, rollback cardinality, response loss,
  immutable old results, authorization/events, and inherited D1/E1 behavior.
- Browser `@regression-scheduling-replay` covers create/calendar reconciliation
  and reschedule replay before stale-version checks.
- Mechanical mapping selects only the focused E3 tests with retries zero.

## Findings

- ARCH-001: Must Fix Current E3; resolved subject to exact-SHA closure.
- No additional E3 finding is registered without measured evidence.

## Closure evidence

- Baseline SHA: `5713e1daf77bc873416686a03ede9f41e62ef032`
- Tested implementation SHA: pending
- GitHub Actions run: pending
- Final evidence descendant: pending

