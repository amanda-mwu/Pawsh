# Rabies appointment compliance

## Contract

The structured rabies expiration date is the operational source for appointment-date rabies
evaluation. Authorized staff may enter it without a document. A supporting PDF
is optional, never establishes verification automatically, and remains
available as supporting evidence after bounded PDF validation; an attachment
never changes rabies eligibility. Historical verification fields remain audit metadata and are
not authoritative for MVP eligibility.

The MVP workflow accepts an expiration date and an optional supporting PDF.
Vaccination date, veterinarian/clinic, certificate reference, notes, verification
status/method/time, and verifying membership remain only as backward-compatible
historical columns. Normal expiration-only updates preserve that metadata and do
not require or synthesize verification values.

## Appointment evaluation

Authoritative inputs are expiration and appointment `scheduled_local_start` in
the business timezone. No expiration is `not_provided`; expiration before the
appointment date is `expires_before_appointment`; otherwise it is
`valid_for_appointment`. Expiration is inclusive. Profile display separately
derives `current`, `expired`, or `not_provided` against the business-local date.
Cross-midnight appointments remain unsupported under existing pilot policy.

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
