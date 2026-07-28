# Data model

Global users authenticate independently from tenant-owned memberships and employees. A membership grants access to a business; an employee represents an operational worker and may optionally reference a membership.

Every operational relationship includes a business ownership path. Composite foreign keys prevent cross-business customer, pet, employee, service, location, appointment, and invoice references. Appointments retain a required location even though the MVP permits only one active location.

Authoritative money uses integer minor units. Appointment services snapshot catalog name, duration, and price. Invoice items take independent snapshots at checkout.
