# Data model

Global users authenticate independently from tenant-owned memberships and employees. A membership grants access to a business; an employee represents an operational worker and may optionally reference a membership.

Every operational relationship includes a business ownership path. Composite foreign keys prevent cross-business customer, pet, employee, service, location, appointment, and invoice references. Appointments retain a required location even though the MVP permits only one active location.

Appointment staffing is appointment-level. `appointment_employees` contains one
or more tenant-scoped groomer assignments and drives calendar capacity; services
describe the work and do not require individual groomer eligibility assignments.
The legacy `appointments.employee_id` value remains the primary-groomer
compatibility projection while consumers migrate to the association.

PostgreSQL 17 is the supported database major in native development, optional
Docker parity, disposable CI, staging, and production. The contract is UTF-8,
UTC database sessions, migration-ordered schema authority, and required
`pgcrypto`/`btree_gist` extensions. Business-local behavior uses stored IANA
timezones rather than server, host, or container defaults.

Authoritative money uses integer minor units. Appointment services snapshot catalog name, duration, and price. Invoice items take independent snapshots at checkout.
Rebooking defaults are pet-specific and bounded to the most recent non-cancelled
appointment. They map historical references to active current groomers and
services; a new booking always resolves current prices and durations before
creating fresh snapshots.
