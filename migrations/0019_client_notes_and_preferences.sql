begin;

-- ---------------------------------------------------------------------------
-- 1. Client note thread
--
-- A customer used to carry a single free-text `customers.notes` value. The
-- client profile now renders a thread of dated, attributed notes, some of which
-- are surfaced prominently ("popup" notes) elsewhere in the product.
--
-- The thread is the source of truth. `customers.notes` is retained as a
-- trigger-maintained mirror of the most recent note so every existing reader of
-- that column and that response key keeps working and can never observe a value
-- that disagrees with the thread.
-- ---------------------------------------------------------------------------

create table customer_notes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  customer_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  pinned boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  -- Composite reference: a note can never point at a customer owned by another
  -- business, matching the pets/appointments/pet_documents tenant pattern.
  foreign key (business_id, customer_id) references customers(business_id, id) on delete cascade
);

create index customer_note_thread
  on customer_notes (business_id, customer_id, created_at desc, id desc);
create index customer_note_pinned
  on customer_notes (business_id, customer_id) where pinned;

-- Preserve the legacy free-text note as the first entry in the thread. Authorship
-- and timestamps follow the customer record, which is the only provenance the old
-- single-column design ever captured. `left(...)` keeps an over-long legacy value
-- from failing the new length constraint instead of failing the migration.
insert into customer_notes (business_id, customer_id, body, created_by, created_at, updated_at)
select business_id, id, left(btrim(notes), 5000), created_by, created_at, updated_at
from customers
where notes is not null and btrim(notes) <> '';

-- A whitespace-only legacy value never became a note, so normalize it to null. The mirror is
-- then exactly "the newest note, or nothing" for every pre-existing row, with no '' vs null gap.
update customers set notes = null where notes is not null and btrim(notes) = '';

-- Created after the backfill so the backfill does not rewrite the column it was
-- read from; the existing `customers.notes` value is already the correct mirror.
create function sync_customer_legacy_notes() returns trigger language plpgsql as $$
declare
  target_business uuid;
  target_customer uuid;
begin
  if tg_op = 'UPDATE'
    and (new.business_id <> old.business_id or new.customer_id <> old.customer_id)
  then
    raise exception 'customer note ownership is immutable';
  end if;
  target_business := coalesce(new.business_id, old.business_id);
  target_customer := coalesce(new.customer_id, old.customer_id);
  update customers set notes = (
    select thread.body from customer_notes thread
    where thread.business_id = target_business and thread.customer_id = target_customer
    order by thread.created_at desc, thread.id desc
    limit 1
  )
  where business_id = target_business and id = target_customer;
  return null;
end $$;

create trigger customer_note_legacy_mirror
  after insert or update or delete on customer_notes
  for each row execute function sync_customer_legacy_notes();

alter table customer_notes enable row level security;
create policy tenant_isolation on customer_notes
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 2. Client preferences
--
-- One row per customer, always present, always read with the customer record,
-- so these live on `customers` rather than in a side table that would only add a
-- join and a "row may not exist yet" case.
--
-- `email_allowed` already covers marketing email and `archived_at` already covers
-- "inactive"; neither is duplicated here.
-- ---------------------------------------------------------------------------

alter table customers
  add column booking_frequency_weeks integer,
  add column block_messages boolean not null default false,
  add column block_online_booking boolean not null default false,
  add column marketing_sms_allowed boolean not null default true;

alter table customers
  add constraint customer_booking_frequency_weeks_range
    check (booking_frequency_weeks is null or booking_frequency_weeks between 1 and 104);

insert into schema_migrations(version) values ('0019_client_notes_and_preferences');
commit;
