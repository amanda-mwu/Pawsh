begin;

-- ---------------------------------------------------------------------------
-- `appointment_services.line_position`: the operator's service order, recorded.
--
-- THE TABLE HAD NO ORDERING COLUMN AND NEVER HAD ONE. Its columns are a random
-- `id`, the two tenant keys, `service_id` and five `*_snapshot` values - no
-- `created_at`, no `position`, no `sort_order`, and a primary key of
-- `gen_random_uuid()`. Every read that wanted the services of one appointment
-- therefore ordered by that random uuid, and a uuid4 sorts by nothing at all.
-- Two services booked as "Full Groom, Nail Trim" rendered in that order or in
-- the other one, per appointment, decided by which uuid the generator happened
-- to produce. Six recent two-service appointments split three and three.
--
-- THE ORDER WAS NEVER LOST DATA; IT WAS NEVER PERSISTED. Both write paths
-- already insert in the operator's order: `POST /api/appointments` and
-- `PUT /api/appointments/:id/services` each loop over the `catalog` array that
-- `resolveServicePrices` returns, and that function's last line is
-- `input.serviceIds.map(...)`, so the array IS the submitted order. Insertion
-- order has been the right answer since 0001; there has simply been no column
-- to write it into and no way to read it back.
--
-- NAMED `line_position` DELIBERATELY. `invoice_items.line_position` (0006) and
-- `invoice_discounts.line_position` (0048) are this schema's existing spelling
-- of "position of a line within a document", and 0048 said in as many words
-- that it was named to match 0006. A Ticket is a document with lines on it, so
-- it takes the same name. `position` is a non-reserved keyword in SQL and reads
-- badly beside `line_position` two tables over; `sort_order` would be a third
-- spelling of one idea.
--
-- ONE-BASED, matching both of its namesakes (`check (line_position > 0)` in
-- 0006, `check (line_position >= 1)` in 0048). The first service on the sheet
-- is line 1, which is what an operator counting the rows would say.
--
-- THIS COLUMN IS THE TICKET'S OWN ORDER AND IS NOT DERIVED FROM AN INVOICE.
-- A Ticket is a CRM/operational work sheet that exists from the moment an
-- appointment is booked; an invoice is downstream financial data that exists
-- only after checkout. Ordering the sheet by `invoice_items.line_position`
-- would mean an uninvoiced visit has no order at all, and that a visit's sheet
-- silently reorders the moment it is checked out. `invoice_items` keeps its own
-- `line_position` and the two stay independent: checkout reads the services in
-- THIS order and numbers the invoice lines from that read, which makes the
-- invoice agree with the sheet without the sheet ever asking the invoice
-- anything.
-- ---------------------------------------------------------------------------

alter table appointment_services
  add column line_position integer;


-- ---------------------------------------------------------------------------
-- THE BACKFILL, AND AN HONEST ACCOUNT OF WHAT IT KNOWS.
--
-- There is NO recorded booking order for a row that already exists. The table
-- has no timestamp and its primary key is random, so nothing stored on an
-- existing row carries the sequence its appointment was booked in. Anything
-- claiming otherwise would be inventing it.
--
-- What `ctid` gives is PHYSICAL ORDER: where the row sits in the heap. Both
-- write paths insert an appointment's services consecutively inside a single
-- transaction, and no path has ever updated or re-inserted one of these rows in
-- place, so for the overwhelming majority of appointments the physical order IS
-- the order the rows were written and therefore the order the operator picked.
--
-- That is a strong likelihood and NOT a guarantee, and the difference is worth
-- stating rather than smoothing over. A page with reclaimed free space, a
-- VACUUM FULL, a pg_dump and restore, or a database rebuilt by some other path
-- can each land these rows in an order that is not their insertion order.
--
-- So what this backfill promises is exactly one thing: DETERMINISTIC LEGACY
-- ORDER. Every historical appointment gets one fixed order that every read now
-- agrees on - probably the order it was booked in, and never worse than the
-- coin flip it replaces. It is NOT a recorded booking order and must not be
-- cited as one anywhere. New rows, written by the two paths this migration
-- ships alongside, carry the real thing.
--
-- The join is on `id` rather than on `ctid`, following 0006's backfill of
-- `invoice_items.line_position` verbatim: `ctid` decides the ORDER and the
-- stable primary key decides which row is being written, so the statement never
-- has to reason about tuple identifiers it is itself moving.
-- ---------------------------------------------------------------------------
with legacy_order as (
  select id, row_number() over (
    partition by business_id, appointment_id order by ctid
  )::integer as position
  from appointment_services
)
update appointment_services service
  set line_position = legacy_order.position
  from legacy_order
  where legacy_order.id = service.id;


-- ---------------------------------------------------------------------------
-- The constraints, added only once every row holds a value.
--
-- `unique (business_id, appointment_id, line_position)` IS TENANT-QUALIFIED,
-- following 0052. The tenant column is not there to make the key unique -
-- `appointment_id` alone would do that, since an appointment belongs to exactly
-- one business - it is there because every other key in this schema that spans
-- tenant data leads with `business_id`, and a key that does not is the one the
-- next reviewer has to stop and reason about.
--
-- BOTH WRITE PATHS CAN MAINTAIN IT, which was checked against the handlers
-- rather than assumed:
--
--   * `POST /api/appointments` inserts the whole loop against an appointment
--     row it created earlier in the same transaction, so there is nothing for
--     it to collide with.
--   * `PUT /api/appointments/:id/services` runs
--     `delete from appointment_services where business_id=... and
--     appointment_id=...` and only then re-inserts, both inside one
--     transaction. The delete empties the key space before the insert refills
--     it, so no intermediate state of that transaction holds two rows at one
--     position. Nothing here needs DEFERRABLE, and it is not made deferrable:
--     an immediate check is what reports the offending statement rather than
--     the commit.
--
-- NO DEFAULT, following 0006. A row admitted without a stated position is a row
-- whose place on the sheet nobody decided, and a default of 1 would let the
-- second such row fail on the unique key with a message about a collision
-- rather than about the omission that caused it.
--
-- AND IT IS THE FIRST INDEX THIS TABLE HAS EVER HAD FOR ITS COMMONEST READ.
-- Until now `appointment_services` carried the primary key on `id` and 0052's
-- `(business_id, id)`, and NOTHING on `(business_id, appointment_id)` - the
-- predicate every per-appointment read uses. PostgreSQL does not index the
-- child side of a foreign key, so "the services on this appointment" has always
-- been a scan. The unique constraint's btree leads with exactly those two
-- columns and answers both the lookup and the ordering, so no separate index is
-- created here.
-- ---------------------------------------------------------------------------
alter table appointment_services
  alter column line_position set not null,
  add constraint appointment_service_position_positive check (line_position >= 1),
  add constraint appointment_service_position_unique unique (business_id, appointment_id, line_position);


-- ---------------------------------------------------------------------------
-- What was true when this ran. The two constraints above validate the table as
-- they are created, so the first check is belt and braces - but CONTIGUITY is a
-- property the backfill has by construction that NO constraint can express, and
-- an appointment whose positions are 1, 2 and 4 satisfies every rule declared
-- above while still being wrong.
-- ---------------------------------------------------------------------------
do $$
declare
  offenders bigint;
begin
  select count(*) into offenders from appointment_services where line_position is null;
  if offenders > 0 then
    raise exception '% appointment_services rows were left without a line_position', offenders;
  end if;

  select count(*) into offenders from (
    select business_id, appointment_id
    from appointment_services
    group by business_id, appointment_id
    having min(line_position) <> 1
        or max(line_position) <> count(*)
        or count(distinct line_position) <> count(*)
  ) gapped;
  if offenders > 0 then
    raise exception '% appointments were backfilled with gapped or duplicated line positions', offenders;
  end if;
end $$;

commit;
