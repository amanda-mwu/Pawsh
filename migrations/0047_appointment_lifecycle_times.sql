begin;

-- ---------------------------------------------------------------------------
-- Stored check-in and check-out times.
--
-- Until now these were DERIVED IN THE CLIENT from `audit_events`:
-- `appointmentLifecycleTimes()` scanned an appointment's activity feed for
-- `appointment.checked_in` and `appointment.completed` and subtracted the two
-- `created_at` stamps. That works for one appointment and does not generalise.
-- `audit_events` carries a single index - `(business_id, created_at desc)` from
-- 0001 - so finding "the check-in event for THIS appointment" is a scan of the
-- business's whole audit history. One detail modal can afford that. The
-- calendar projection, which both the calendar and Check Out read, cannot.
--
-- WHY THIS IS NOT A STATUS-TRANSITION TABLE, AND MUST NOT BECOME ONE.
-- `audit_events` already IS Pawsh's transition log, and `record()` is its only
-- writer. A second table recording the same transitions would be exactly the
-- two-sources-of-truth failure the comments in this schema keep warning about,
-- and the two would disagree the first time a write path forgot one of them.
-- The distinction that makes a COLUMN legitimate where a second LOG would not
-- be: the audit event answers "who did what, and when did they do it", and is
-- append-only and permanent. The column answers "what is true now", is one
-- value, and is EDITABLE - an operator who checked a dog in twenty minutes
-- late must be able to correct the record without the audit trail losing the
-- fact that the correction happened. `PATCH /api/appointments/:id/times`
-- writes the column and records its own audit event; the original transition
-- event stays exactly where it was.
--
-- NULLABLE, NO DEFAULT. A visit that has not been checked in has no check-in
-- time, and `null` is what that is - the same rule 0023 set for partial client
-- records. Appointments predating the audit path get null from the backfill
-- below and the detail view keeps saying "not recorded", which is true.
--
-- `end_at` IS NOT DERIVED FROM THESE AND NEVER MAY BE. `start_at`/`end_at` are
-- THE SCHEDULE - the interval the business committed a groomer to - and these
-- two columns are WHAT ACTUALLY HAPPENED. They are routinely different and the
-- difference is the point. Conflating them would also break
-- `employee_appointment_no_overlap` from 0001, which is an exclusion
-- constraint over `tstzrange(start_at, end_at)`: a check-out recorded late
-- would retroactively widen a booked interval into a colleague's and start
-- rejecting writes to appointments nobody touched.
--
-- NO INDEX. Nothing filters or sorts on either column. The calendar projection
-- reads them through `a.*` on rows it has already selected by
-- `(business_id, start_at)`, and an index that no predicate reaches is write
-- cost with no read to pay for it.
-- ---------------------------------------------------------------------------

alter table appointments
  add column checked_in_at timestamptz,
  add column checked_out_at timestamptz;

-- ---------------------------------------------------------------------------
-- THE BACKFILL, which is what keeps this from being a visible regression.
--
-- Every appointment that renders a duration today renders it because the two
-- audit events exist. Shipping the columns empty would blank the check-in
-- time, the check-out time and the actual duration on every historical visit
-- in the product, and the operator would have no way to tell that from the
-- data having never been recorded.
--
-- `distinct on (resource_id) ... order by resource_id, created_at` takes the
-- EARLIEST event of each kind per appointment. `canTransition` in
-- @pawsh/domain admits exactly one path to each of these states - scheduled ->
-- checked_in -> in_service -> completed, with `completed` terminal - so there
-- is at most one of each and "earliest" and "only" are the same row today. It
-- is written as earliest anyway, because the honest answer to "when was this
-- checked in" is the first time it was, not the last.
--
-- SCOPED BY BUSINESS as well as by id. `audit_events.resource_id` is an
-- untyped uuid with no foreign key - it points at appointments, invoices,
-- payments and coupons alike - so the `resource_type` filter is what makes the
-- join meaningful and the `business_id` equality is what makes it tenant-safe
-- even if a uuid were ever reused.
--
-- CANCELLED AND NO-SHOW DELIBERATELY GET NO CHECK-OUT TIME. The client
-- derivation treated `appointment.cancelled` and `appointment.no_show` as
-- check-outs, which reads a cancellation as the end of a visit that in most of
-- those cases never began. A cancelled appointment did not check out; it
-- stays "not recorded", which is what happened.
-- ---------------------------------------------------------------------------

update appointments a
set checked_in_at = event.created_at
from (
  select distinct on (resource_id) resource_id, business_id, created_at
  from audit_events
  where action = 'appointment.checked_in'
    and resource_type = 'appointment'
    and resource_id is not null
  order by resource_id, created_at
) event
where event.resource_id = a.id and event.business_id = a.business_id;

update appointments a
set checked_out_at = event.created_at
from (
  select distinct on (resource_id) resource_id, business_id, created_at
  from audit_events
  where action = 'appointment.completed'
    and resource_type = 'appointment'
    and resource_id is not null
  order by resource_id, created_at
) event
where event.resource_id = a.id and event.business_id = a.business_id;

-- The backfill VERIFIES ITSELF before the constraint is asked to, so a failure
-- here names the problem instead of surfacing as a bare check violation on a
-- table with two new columns. It should be unreachable: `completed` is only
-- reachable from `in_service`, which is only reachable from `checked_in`, and
-- each transaction's `now()` is taken after the previous one committed.
do $$
declare
  inverted bigint;
begin
  select count(*) into inverted
  from appointments
  where checked_in_at is not null
    and checked_out_at is not null
    and checked_out_at < checked_in_at;
  if inverted > 0 then
    raise exception 'backfill produced a check-out before its check-in on % appointment(s)', inverted;
  end if;
end $$;

-- Either may be absent independently - a visit in progress has a check-in and
-- no check-out - so the constraint only has an opinion when BOTH are present.
-- Equality is admitted: a same-minute correction is a real thing an operator
-- can enter, and rejecting it would be the constraint arguing with the record.
alter table appointments
  add constraint appointment_times_ordered
    check (checked_out_at is null or checked_in_at is null or checked_out_at >= checked_in_at);

insert into schema_migrations(version) values ('0047_appointment_lifecycle_times');
commit;
