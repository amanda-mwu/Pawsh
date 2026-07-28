# Scheduling

Appointments use canonical timestamps and location IANA timezones. Intervals are half-open: `[start_at, end_at)`. Adjacent appointments do not conflict.

Scheduled, checked-in, and in-service appointments reserve employee time. Cancelled and no-show appointments do not. Completed appointments are historical. A PostgreSQL exclusion constraint is the final overlap authority, including concurrent inserts.

The MVP transition path is scheduled → checked-in → in-service → completed, with scheduled → cancelled/no-show alternatives. The server rejects all other transitions.
