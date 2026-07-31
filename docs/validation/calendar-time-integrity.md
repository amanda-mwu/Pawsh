# Calendar & Time Integrity

## Classification

Candidate classification: **Calendar & Time Integrity Valid**.

This record becomes final only when its final exact SHA is clean, equals
`origin/main`, and every required CI job is green. It extends, and does not
rewrite, D1 through D4 or Automated Critical Regression evidence.

## Confirmed findings and disposition

| Finding | Evidence | Disposition |
| --- | --- | --- |
| TIME-001 | Browser `datetime-local`, display, reschedule, and today logic used the device timezone | Must Fix Current E1; resolved by location-authoritative input and display |
| TIME-002 | APIs accepted resolved offsets and had no nonexistent/repeated wall-time contract | Must Fix Current E1; resolved by strict server wall-time resolution |
| TIME-003 | Appointments retained UTC only and historical presentation depended on mutable location timezone | Must Fix Current E1; resolved with timezone/local/offset/disambiguation snapshots |
| TIME-004 | Browser constructed UTC calendar ranges from device time | Must Fix Current E1; resolved with bounded server-resolved local-date ranges |
| TIME-005 | Availability SQL assumed a same-day interval without an explicit cross-midnight contract | Accepted controlled-pilot limitation; working-hour rows and appointments must remain within one local day |
| TIME-006 | Timezones were nonempty strings and settings writes had no stale precondition | Must Fix Current E1; resolved with IANA validation, location versioning, locking, and audit |

## Authority and pilot scope

The database permits one active location per business. E1 therefore validates a
single-location controlled-pilot model. The active tenant-owned location's IANA
timezone is scheduling authority. Clients submit location identity, strict local
wall time, optional DST disambiguation, and the expected location version; they
do not select timezone authority.

UTC `start_at` and `end_at` are immutable historical instants and the basis for
conflicts, elapsed duration, ordering, reminders, and resource overlap.
Appointments also retain `scheduling_timezone`, `scheduled_local_start`, the
resolved UTC offset, and any `earlier`/`later` choice. A location settings change
does not rewrite them. A successful reschedule records new intent using the
current location timezone.

## Input, DST, and duration contract

Mutation input is exactly minute-precision `YYYY-MM-DDTHH:mm`. Seconds,
fractions, offsets, `Z`, whitespace, `24:00`, and invalid calendar dates are
rejected. Node 24 `Intl`/ICU provides IANA data behind a centralized server
resolver. Nonexistent spring-forward time is rejected. Repeated fall-back time
requires `earlier` or `later`. Conversion failure never falls back to UTC,
browser time, or a fixed offset.

Service duration is elapsed minutes: `end_at = start_at + duration`. Existing
service snapshots remain authoritative. E1 rejects appointments that cross
local midnight; weekly hours likewise require `start < end`. One-off blocked
time uses the same local resolver and persists a concrete UTC interval plus its
local/zone context.

## Calendar, today, and history

Day-calendar membership is the snapshotted local start date. Timeline mode is
UTC interval overlap. Calendar ranges accept a valid local start date and 1–31
days. Snapshotted local-start and bounded UTC-envelope predicates avoid per-row
timezone conversion. Local days naturally span 23 or 25 elapsed hours.

"Today" is the current instant rendered in the active location timezone.
Operational and history UI formats appointments using their scheduling snapshot,
not device timezone. Date-only Pet Care fields retain their independent
`YYYY-MM-DD` semantics.

## Settings race, audit, and reminder contract

Timezone updates require current `settings.manage`, validate IANA identity,
lock the active location at the expected version, increment once, and write the
existing `business.settings.update` audit with old/new timezone. Appointment
create/reschedule locks the same location and checks the expected version, so a
settings race either serializes with one coherent snapshot or returns
`STALE_LOCATION_SETTINGS`.

Reminder occurrence remains appointment instant minus elapsed lead minutes.
Reminder presentation uses the appointment's scheduling-timezone snapshot.
Timezone settings do not move an unchanged reminder; existing reschedule and
terminal-state outbox behavior remains inherited.

## Validation mapping

- Domain: `tests/domain/time.test.ts` covers strict syntax, leap date, IANA
  validation, spring gap, fall repetition, and 23/25-hour boundaries.
- Database: scheduling regression covers DST rejection, bounded ranges,
  timezone validation/version/audit, inherited locks, overrides, blocked time,
  deterministic ordering, and query diagnostics.
- Browser: `@regression-calendar-time` covers a New York device operating a Los
  Angeles location plus DST gap/repetition behavior. Mechanical mapping is
  isolated under `chromium-regression`; retries are zero.
- Inherited: all D1–D4, D3.1/D3.2, security, smoke, cross-browser, responsive,
  migration, backup/restore, lint, typecheck, unit/database, build, and
  production-audit jobs remain required on the final exact SHA.

## Known limitations

- Controlled pilot supports one active location per business.
- Cross-midnight appointments and overnight weekly-hour rows are unsupported.
- IANA/ICU identifiers do not freeze future historical timezone-rule revisions;
  immutable UTC and original intent evidence are retained.
- Real-device time pickers, real Safari, staging runtime/ICU, and human UX remain
  later pre-pilot gates.

## Closure evidence

- Baseline SHA: `743fe52310d697b3d97fb3093b66f32e52fa2b62`
- Candidate SHA: pending
- Final SHA: pending
- GitHub Actions run: pending
- Exact-head required checks: pending
