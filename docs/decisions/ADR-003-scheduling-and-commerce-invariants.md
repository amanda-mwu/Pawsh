# ADR-003: Scheduling and commerce invariants

Status: Accepted

Appointments use UTC timestamps and half-open `[start_at, end_at)` intervals. PostgreSQL exclusion constraints prevent one employee from holding overlapping appointments in reserving states. Location records retain the IANA timezone needed for local display and availability rules.

Appointments describe operational state. Invoices and manual payments describe financial state. Appointment services snapshot duration and price at booking; invoice items copy independent financial snapshots at checkout. Authoritative money values use integer minor units.
