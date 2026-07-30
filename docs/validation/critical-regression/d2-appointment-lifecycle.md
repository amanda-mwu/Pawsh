# Critical Regression D2 — Appointment Lifecycle

## Classification

Critical Regression D2 — Appointment Lifecycle Valid.

This closure does not establish Automated Critical Regression Valid. D3
customer/pet history and D4 checkout/stale-state/error paths remain independent
gates.

## Capability and transition contract

| Source | Action | Target | Permission | Success | Invalid/repeat | Stale supplied version | Audit | Outbox | Analytics | Occupancy |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |
| `scheduled` | Check in | `checked_in` | `operations.check_in` | 200 | 400 | 409 | `appointment.checked_in` | `AppointmentCheckedIn` | N/A | Blocking |
| `checked_in` | Start service | `in_service` | `operations.perform_service` | 200 | 400 | 409 | `appointment.in_service` | `AppointmentStarted` | N/A | Blocking |
| `in_service` | Complete | `completed` | `operations.complete` | 200 | 400 | 409 | `appointment.completed` | `AppointmentCompleted` | `AppointmentCompleted` | Nonblocking |
| `scheduled` | Cancel | `cancelled` | `appointments.cancel` | 200 | 400 | 409 | `appointment.cancelled` | `AppointmentCancelled` | N/A | Nonblocking |
| `scheduled` | No-show | `no_show` | `appointments.cancel` | 200 | 400 | 409 | `appointment.no_show` | N/A | N/A | Nonblocking |

All five transitions are implemented, exposed where applicable, required for
the controlled-pilot workflow, and validated. `completed`, `cancelled`, and
`no_show` are terminal. Reopen is absent and deferred. Missing permission
returns 403; an appointment outside authenticated tenant scope returns 404.

Every other edge in the six-state graph is rejected by the shared domain state
machine. PostgreSQL's `appointment_status` enum constrains stored values, while
the locked route transition check constrains valid edges. The production status
mutation inventory found one normal lifecycle mutation path; QA seeding is the
only direct insert and is explicitly fixture-only.

## Version and repeat contract

`version` remains optional. When supplied, mismatch returns 409. When omitted,
the tenant-scoped `FOR UPDATE` row lock and current-state validation remain
authoritative; an invalid or repeated transition returns 400. Version is useful
stale-client evidence, not the sole integrity mechanism.

The concurrent completion test supplies the same current version from both
clients, so its exact response pair is one 200 and one 409. A repeated
completion produces no additional audit, outbox, or analytics effect.

## D1 occupancy integration

Database integration proves a conflicting normal booking remains rejected while
the appointment is `scheduled`, `checked_in`, and `in_service`. After
`completed`, `cancelled`, or `no_show`, a normal appointment may use the same
employee interval.

All lifecycle transitions acquire D1's business/employee scheduling advisory
lock. In the deterministic lifecycle-versus-booking tests:

- booking lock first: booking sees the blocking appointment and returns 409;
  completion then commits;
- lifecycle lock first: completion makes the appointment nonblocking; booking
  then returns 201.

Neither order produces an accidental overlap.

## Concurrency evidence

The injected lifecycle test seam is immediately before the tenant-scoped
appointment `FOR UPDATE` query. It holds no appointment or scheduling lock.
Both independent authenticated requests reach the seam, are released together,
and PostgreSQL serializes them through production row-lock logic.

Concurrent supplied-version completion result:

- responses: 200 and 409;
- final appointment state: `completed`;
- scoped `appointment.completed` audit count: 1;
- scoped `AppointmentCompleted` outbox count: 1;
- scoped `AppointmentCompleted` analytics count: 1;
- unhandled 5xx: 0;
- partial mutation or duplicate effect: 0.

Counts are scoped by business, appointment resource ID, and action/event name in
an isolated database fixture.

## Event and event-time policy

All successful transitions create exactly one appointment-scoped audit.
Check-in, start, completion, and cancellation create exactly their documented
outbox event. No-show intentionally has no outbox or analytics event because no
current pilot downstream contract consumes one. Rejected transitions create no
success event.

Completion analytics remains part of the atomic transition transaction. It is a
durable product event in the current architecture, its write is constant and
local, and CI found no operational or latency evidence requiring decoupling.

Dedicated lifecycle timestamp columns are deferred:

- `audit_events.created_at` is recorded transition time;
- `outbox_events.occurred_at` is durable event creation time;
- `outbox_events.processed_at` is worker processing time only;
- `appointments.updated_at` is the latest record mutation, not a milestone.

Dedicated timestamps must be reconsidered before actual-duration,
labor-productivity, SLA, or dispute-timeline reporting requires them.

## Browser validation

The `chromium-regression` project mechanically selects exactly four
`@regression-lifecycle` tests:

1. primary UI lifecycle with reload persistence;
2. completed/no-show terminal control coherence;
3. disabled, single-flight completion with exactly one request;
4. two-context stale action rejection and authoritative reconciliation.

The stale browser receives the documented 409, retains understandable feedback,
refreshes application state without a page reload, removes the obsolete action,
and renders the current action.

Implementation CI run
[30585626690](https://github.com/amanda-mwu/Pawsh/actions/runs/30585626690)
passed all 13 Chromium regression tests (nine D1 plus four D2) in 22.1 seconds
with one worker and retries set to zero.

## Latency and scale review

Lifecycle mutation queries are bounded by tenant and appointment ID and perform
constant scoped event writes. No history scan, tenant-wide audit scan, N+1
loop, or synchronous outbox processing occurs in the request.

The current browser reconciliation uses the existing bounded application
refresh. No pilot-blocking latency was observed, so a targeted appointment
refresh was not introduced. The combined D1/D2 Chromium regression suite
completed in 22.1 seconds; the five-file PostgreSQL suite completed 36 tests in
4.59 seconds. These are diagnostic CI observations, not performance gates.

## Findings

| ID | Evidence and impact | Disposition | Status/trigger |
| --- | --- | --- | --- |
| UX-002 | Stale lifecycle errors left obsolete client controls | Must Fix Current D Batch | Resolved with handled-error feedback and authoritative refresh |
| ARCH-002 | Lifecycle version is optional | Accepted / Documented Current Limitation | Reconsider for a public/mobile mandatory optimistic-concurrency contract |
| GOV-002 | No dedicated lifecycle milestone columns | Accepted / Documented Current Limitation | Reconsider before milestone-dependent reporting |
| ARCH-003 | No-show has no domain outbox event | Accepted / Documented Current Limitation | Add only when a downstream no-show contract exists |

`ARCH-004`, `LAT-002`, and `GOV-003` were reviewed but not confirmed. Existing
D1 findings retain their prior dispositions.

## Closure evidence

Implementation candidate:
`c3abdf1beaf3a590c5a7426990f47f9795067448`

Implementation CI:
[30585626690](https://github.com/amanda-mwu/Pawsh/actions/runs/30585626690)

All 13 required jobs passed: static validation; backend/PostgreSQL; backup and
restore; Chromium smoke, regression, security, and cross-browser; Firefox and
WebKit cross-browser; iPhone security; and all responsive profiles.

The final authoritative SHA is the documentation-containing clean repository
HEAD whose required CI is green. It is recorded by CI and the final closure
report rather than embedded here because embedding a commit's own SHA in its
contents is self-referential.

## Scope boundary

D2 does not validate customer/pet history, checkout and broader error paths,
dedicated lifecycle timestamps, performance gating, staging, manual UX, or
physical devices.
