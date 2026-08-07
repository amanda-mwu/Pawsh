# Rabies appointment compliance

## Contract

Structured Pet Care data is the operational source for appointment-date rabies
evaluation. Authorized staff may enter it without a document. A supporting PDF
is optional, never establishes verification automatically, and remains
available as supporting evidence after bounded PDF validation; an attachment
never verifies rabies status. Structured staff verification remains authoritative.

The record includes vaccination and expiration dates, veterinarian/clinic,
certificate reference, bounded notes, verification status and method,
verification time, and authoritative verifying membership. Verification states
are `not_provided`, `unverified`, and `staff_verified`; expiration is derived,
not stored as a stale verification state. Staff verification requires an
expiration and method. The server binds it to the current membership. Existing
expiration-only records migrate to unverified; missing records to not provided.

## Appointment evaluation

Authoritative inputs are verification, expiration, appointment
`scheduled_local_start`, and location timezone. The appointment start date is
used and expiration is inclusive. Results are `valid_for_appointment`,
`expires_before_appointment`, `expired`, `unverified`, and `not_provided`. They
are derived on reads and reconciliation. Cross-midnight appointments remain
unsupported under existing pilot policy.

## Notifications and resolution

Creation, rescheduling, and material Pet Care changes use transactional outbox
events. The worker reconciles a bounded future set and creates material-keyed:

- customer email intents, or inspectable `suppressed` intents when unavailable;
- staff intents for active owners/settings administrators; and
- staff intents for the assigned employee when linked to an active membership.

Database uniqueness prevents duplicate logical intents. Rescheduling or Pet Care
changes cancel stale unsent intents before reconciliation. Cancellation/no-show
cancels unsent rabies intents. Delivered history remains; no all-clear message is
sent. Delivery remains asynchronous and retry-safe. Messages contain no document
link, raw HTML, or scanner details. Existing email permission is an application
suppression input; its legal sufficiency for this transactional notice remains a
Product/Privacy decision.

## Governance and release boundary

Compliance data, customer contact, verifier identity, notification evidence,
uploaded content, and audit records retain existing tenant retention, export,
offboarding, backup, and incident controls. Physical deletion, legal hold, and
long-term notification retention require approval before GA. Deactivation never
rewrites historical verifier or resolved-recipient identity.

Current PDF checks are not malware detection. `SEC-DOC-001` remains a
controlled-pilot blocker. Manual entry does not waive it while uploads are
enabled. See the [proposed limited-pilot decision](../decisions/proposed-rabies-limited-pilot-policy.md)
and [gate matrix](../releases/controlled-pilot-execution-plan.md).
