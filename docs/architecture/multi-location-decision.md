# Multi-location architecture decision

Pawsh remains intentionally single-location for the current MVP. The database
contains a `locations` table, but the current application treats a business as
both the tenant/workspace boundary and the single operating salon. A partial
unique index permits only one active location per business, and runtime queries
resolve that active location without a caller-selected location identifier.

Adding a location selector would therefore be misleading and unsafe as a UI-only
change. A future multi-location design should make `business` the tenant and
allow multiple child `locations`, then explicitly scope Calendar, appointments,
groomer assignments, business hours, and location-specific configuration. The
migration must preserve existing location IDs, define membership/location
authorization, and reject unauthorized location IDs at every API boundary.
Services and pricing should remain tenant-wide unless a separate product decision
defines location-specific catalogs.

No location schema, selector, or partial location-scoping behavior is introduced
by the calendar and navigation readiness refinement.
