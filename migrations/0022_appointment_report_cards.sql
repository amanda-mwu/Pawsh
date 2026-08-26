begin;

-- ---------------------------------------------------------------------------
-- Appointment report cards
--
-- A short write-up of one pet's visit: what was done, by whom, and a note from
-- the groomer, shown alongside the before-and-after photographs already attached
-- to the appointment.
--
-- The card stores only what a person wrote. Everything else it displays — the
-- services, the groomer, the date, the photographs — is read from the appointment
-- at render time rather than copied in here. A snapshot would have to be kept in
-- step with photos being added and removed after the card was made, and a card
-- showing a photograph that was deleted for being bad is worse than one that
-- simply reflects the visit as it currently stands.
--
-- The consequence is stated rather than hidden: a card sent by email carries the
-- wording that existed when it was sent, and `last_sent_at` records when that was,
-- so a later edit is visibly an edit made after sending.
-- ---------------------------------------------------------------------------

create table appointment_report_cards (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  appointment_id uuid not null,
  pet_id uuid not null,
  customer_id uuid not null,

  note text check (note is null or char_length(note) <= 4000),

  -- Optimistic concurrency, matching appointments and pets: two staff members with
  -- the same card open must not silently overwrite one another's wording.
  version integer not null default 1 check (version > 0),

  last_sent_at timestamptz,
  send_count integer not null default 0 check (send_count >= 0),
  last_sent_channel text check (last_sent_channel is null or last_sent_channel in ('email')),

  created_by uuid not null references users(id),
  updated_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (business_id,id),
  -- One card per pet per visit. A second card for the same groom is not a product
  -- decision anybody has made, and two would leave "which one did the client get?"
  -- unanswerable.
  unique (business_id,appointment_id,pet_id),
  foreign key (business_id,appointment_id) references appointments(business_id,id),
  foreign key (business_id,pet_id) references pets(business_id,id),
  foreign key (business_id,customer_id) references customers(business_id,id),
  -- A card cannot claim to have been sent without a time, or carry a time without
  -- having been sent.
  check ((send_count = 0 and last_sent_at is null and last_sent_channel is null)
      or (send_count > 0 and last_sent_at is not null and last_sent_channel is not null))
);

-- The client profile and the appointment detail both read cards by their appointment.
create index appointment_report_card_lookup
  on appointment_report_cards(business_id,appointment_id,created_at,id);

alter table appointment_report_cards enable row level security;
create policy tenant_isolation on appointment_report_cards
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

commit;
