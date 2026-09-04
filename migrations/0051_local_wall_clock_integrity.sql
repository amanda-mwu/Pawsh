begin;

-- ---------------------------------------------------------------------------
-- The denormalised local wall clock is derived from the instant, and the
-- database now says so.
--
-- `appointments.scheduled_local_start` and the `blocked_times` pair are
-- `timestamp without time zone`: a wall clock at the salon, kept beside the
-- authoritative `timestamptz` instant so the calendar can range-scan on a
-- local date without converting every row. 0007 introduced them and backfilled
-- them correctly, as `start_at at time zone l.timezone`.
--
-- THE WRITE PATHS THEN STOPPED DOING THAT. `POST /api/appointments`,
-- `PATCH /api/appointments/:id/schedule` and `POST /api/blocked-times` each
-- bound the operator's own local string - `${input.localStart}` - straight
-- into the naive column. postgres.js keys its serializers on the parameter
-- type the server describes, and 1082/1114/1184 all resolve to
-- `x => (x instanceof Date ? x : new Date(x)).toISOString()`. A zone-less
-- string handed to `new Date` is read in the API HOST's timezone, so the value
-- that reached the column was the UTC clock of the intended local time. On a
-- Pacific host a 12:30 booking persisted as 19:30.
--
-- WHY IT SURVIVED THIS LONG: it is a no-op when the API host runs in UTC, and
-- `start_at` was never wrong, so every surface that derives from the instant -
-- the calendar, the appointment detail, the Ticket - went on rendering the
-- correct time over a corrupted row. Two read paths in `routes.ts` had already
-- noticed and worked around it by refusing to read the column at all; those
-- notes describe history now rather than a live hazard.
--
-- THE REPAIR IS A RECOMPUTATION, NOT A GUESS. `start_at` is authoritative and
-- was never affected, so `start_at at time zone scheduling_timezone` is the
-- correct wall clock for every row whether or not that row was damaged. There
-- is no need to tell a corrupted row from a sound one: the statement is a
-- no-op on rows that already agree, which is what `is distinct from` filters
-- for, and it is idempotent on re-run.
--
-- WHY THE CONSTRAINT IS WRITTEN IN THIS DIRECTION AND NOT THE OTHER. Checking
-- `start_at = scheduled_local_start at time zone scheduling_timezone` would
-- look equivalent and would be wrong: in the repeated hour of a fall-back DST
-- transition a naive local time names TWO instants, Postgres picks the later
-- one, and a booking Pawsh deliberately resolved to the earlier instant -
-- `scheduled_disambiguation = 'earlier'`, which the schema exists to record -
-- would be refused. Converting an instant TO a wall clock is single-valued in
-- every case, so this direction is total. `timezone(text, timestamptz)` is
-- IMMUTABLE, which is what lets it appear in a check at all.
-- ---------------------------------------------------------------------------

update appointments
  set scheduled_local_start = (start_at at time zone scheduling_timezone)
  where scheduled_local_start
    is distinct from (start_at at time zone scheduling_timezone);

update blocked_times
  set scheduled_local_start = (start_at at time zone scheduling_timezone),
      scheduled_local_end = (end_at at time zone scheduling_timezone)
  where scheduled_local_start
      is distinct from (start_at at time zone scheduling_timezone)
    or scheduled_local_end
      is distinct from (end_at at time zone scheduling_timezone);

alter table appointments
  add constraint appointment_local_start_matches_instant
  check (scheduled_local_start = (start_at at time zone scheduling_timezone));

alter table blocked_times
  add constraint blocked_time_local_window_matches_instants
  check (scheduled_local_start = (start_at at time zone scheduling_timezone)
     and scheduled_local_end = (end_at at time zone scheduling_timezone));

commit;
