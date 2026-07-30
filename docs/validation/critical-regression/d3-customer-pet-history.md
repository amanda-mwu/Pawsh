# Critical Regression D3 — Customer/Pet History

## Classification

Critical Regression D3 — Customer/Pet History Valid.

This does not establish Automated Critical Regression Valid. D4
checkout/stale-state/error paths remains an independent gate.

## Capability matrix

| Capability | Implemented | UI | Pilot/D3 required | Permission | Result |
| --- | --- | --- | --- | --- | --- |
| Customer create, list/search, edit, archive, history | Yes | Yes | Yes | `customers.edit` / `customers.view` | Validated |
| Customer hard delete | No | No | No | N/A | Deferred |
| Pet create, list/search, profile edit | Yes | Yes | Yes | `pets.edit`; reads use `pets.view` | Validated |
| Pet safety view/edit | Yes | Yes | Yes | `pets.safety.view`; edit requires `pets.edit` + `pets.safety.edit` | Validated |
| Pet archive | API | No | API semantics required | `pets.edit` | Lower-layer validated; UI deferred |
| Pet-specific history endpoint | No | No | No | N/A | Deferred |
| Customer appointment/terminal history | Yes | Yes | Yes | `customers.view` | Validated |
| Financial history summary | Yes | Yes | Yes | `customers.view` + `payments.view` | Validated |
| Service snapshots in storage | Yes | No | Yes for integrity | Appointment authority | Validated |
| Detailed service-history presentation | No | No | No | N/A | Deferred |

## Safety and pet version contracts

The protected set is `safetyAlerts`, `medicalNotes`, `behaviorNotes`,
`emergencyContact`, `veterinarian`, `vaccinationNotes`, and
`vaccinationExpiresOn`. Vaccination expiry is protected health/safety context.
One shared server definition controls redaction, authorization, comparison, and
audit metadata. A caller without `pets.safety.view` receives ordinary identity
with protected fields redacted to `null`.

Profile and safety updates are separate. Profile accepts ordinary fields under
`pets.edit` and preserves protected fields. Safety accepts only protected fields
and requires `pets.edit` plus `pets.safety.edit`. Both require `version`:
missing is 400, stale is 409, and success increments once. Omitted safety values
remain unchanged; explicit null clears only through the authorized operation.

Migration `0003_pet_versions.sql` initializes version 1 with positive/non-null
constraints. Tenant/pet/version conditional updates prevent stale replacement.
Two-client lower-layer and browser coverage proves no partial stale write and
refreshes the open edit form without automatic resubmission.

`pet.safety.update` is emitted once only when normalized protected values
actually change. Same-value, profile, unauthorized, and stale updates emit zero.
The payload contains changed field names only, never sensitive values.

## Customer and archive contracts

Customer PUT remains full replacement and last-write-wins. The former form
omitted persisted address, preferred-contact, email-consent, and notes fields;
D3 now round-trips all supported customer fields. Customer optimistic
concurrency is deferred.

Archive policy B is authoritative. Archived customers disappear from active
customer search. Their pets remain persisted and keep their own archive flag,
but active operational pet queries require active pet and active parent.
Booking is denied while authorized history and foreign keys remain intact. Pet
archive independently suppresses the pet without deleting history. Hard delete
is absent.

## History semantics and permissions

Customer, pet, and employee names are current relational values. Pet safety is
current operational state, not a service-time snapshot.
`appointment_services` preserves booking-time service name, duration, and
price; later catalog edits do not rewrite it.

Service-time customer, pet, employee, and safety snapshots do not exist.
Detailed service-history presentation and pet-specific history are deferred;
D3 does not claim the UI presents service snapshots. Customer history includes
its current appointment rows, including terminal states.

Invoice totals, balance, status, and receipt-related data are projected only
with `payments.view`. `customers.view` alone receives non-financial history.
D4 remains responsible for financial arithmetic and payment lifecycle.

## Search, ordering, and query evidence

Customer search is tenant-scoped and active-only; name/email use
case-insensitive contains, phone uses normalized contains, results are limited
to 100 and ordered `last_name ASC, first_name ASC, id ASC`. Pet search is
tenant-scoped, active-pet/active-parent-only, optional customer-scoped,
case-insensitive name/breed contains, limited to 100, and ordered
`name ASC, id ASC`.

History ordering is appointments `start_at DESC, id DESC`, invoices
`created_at DESC, id DESC`, and pets `name ASC, id ASC`.

The isolated deterministic `d3-v1` CI seed used 2,000 customers, 3,000 pets,
and a 300-appointment high-frequency customer. Three warm API samples in
PostgreSQL CI (browser startup excluded) recorded:

| Operation | Median | Payload | Rows |
| --- | ---: | ---: | ---: |
| Customer contains search | 6.35 ms | 50,593 bytes | 100 |
| Pet contains search | 12.95 ms | 75,287 bytes | 100 |
| High-frequency customer history | 11.98 ms | 223,926 bytes | 300 |

Queries are tenant/customer scoped, search is capped, and no N+1 was found.
The measured path did not justify trigram indexes, pagination, or planner-node
gates. LAT-003 was not confirmed. These are diagnostics, not performance gates.
GOV-001 remains open pending product approval of the provisional envelope.

## Browser and findings

`chromium-regression --grep @regression-crm-history --list` selects exactly four
tests with retries zero: create/reload; safety edit and stale reconciliation;
search/archive scoping; and current-name/terminal/financial history.

| ID | Impact | Disposition | Status |
| --- | --- | --- | --- |
| SEC-002 | Unauthorized safety disclosure/mutation | Must Fix Current D Batch | Resolved |
| ARCH-005 | Stale replacement could erase safety data | Must Fix Current D Batch | Resolved |
| GOV-004 | Current/snapshot semantics could be overstated | Must Fix Current D Batch | Resolved |

UX-003, LAT-003, ARCH-006, and GOV-005 were inspected but not confirmed.

## Validation and closure evidence

Implementation commits:

- `4ac1a45f50be682c8f30b06b03234e4690d0f1d8`
- `81b8364784f3728627b0db26a7ab53e307bbcc34`
- `7d1edf82d7d4385a34add0f9dc509150067b87a2`

Implementation CI
[30590839273](https://github.com/amanda-mwu/Pawsh/actions/runs/30590839273)
passed all 13 required jobs. PostgreSQL ran 40 tests across six files in 6.12
seconds. Chromium regression passed all 17 D1–D3 tests.

The authoritative closure is the clean documentation-containing final HEAD
reported in the final report and proven by its own full CI. Its SHA is not
embedded because doing so would create a different SHA.

## Known limitations

D3 does not establish detailed service-history projection, pet-specific
history, service-time identity/safety snapshots, hard delete, customer
optimistic concurrency, D4 checkout/error paths, full performance,
accessibility, staging, manual UX, or physical-device validity.
