begin;

-- ---------------------------------------------------------------------------
-- Appointment photos
--
-- Before-and-after photographs of a pet, taken during the visit they belong to.
--
-- These deliberately do NOT live in `pet_documents`. That table is rabies
-- evidence: exactly one current record per pet per type, an immutability trigger
-- that forbids editing what was attested to, a supersession lifecycle, and a
-- `content_type = 'application/pdf'` constraint. A grooming photo is the
-- opposite kind of record — there are many per visit, they carry no legal
-- weight, and a groomer who takes a bad one should simply be able to delete it.
-- Forcing photos through the evidence lifecycle would either weaken the
-- guarantees that table exists to provide, or saddle photos with rules that make
-- no sense for them.
--
-- `phase` is 'before' or 'after' and nothing else. A third bucket ("during",
-- "detail") is a product decision nobody has made, and inventing one here would
-- put rows in the database that no part of the interface knows how to show.
-- ---------------------------------------------------------------------------

create table appointment_photos (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  appointment_id uuid not null,
  pet_id uuid not null,
  phase text not null check (phase in ('before','after')),

  -- Two states only. A row is 'pending' between reserving its storage key and the
  -- object landing; anything that never reaches 'stored' is a failed upload and is
  -- deleted rather than shown. There is no scan state: Pawsh has no malware
  -- scanner wired up, and a state implying one ran would be a lie in the schema.
  state text not null check (state in ('pending','stored')),

  storage_key text not null unique,
  -- The allow-list is enforced here as well as in the route because these bytes are
  -- served back inline to a browser. A row that reached the table with some other
  -- type would be a stored-XSS vector no response header could fully close.
  content_type text not null check (content_type in ('image/jpeg','image/png','image/webp')),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  size_bytes bigint check (size_bytes is null or size_bytes > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  original_filename text not null check (char_length(original_filename) between 1 and 180),

  -- Supplied by the client so a retried upload — a flaky connection on a phone in a
  -- grooming room is the expected case — reconciles to the row it already created
  -- instead of storing the same photograph twice.
  upload_request_id uuid not null,

  uploaded_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (business_id,id),
  unique (business_id,appointment_id,upload_request_id),
  foreign key (business_id,appointment_id) references appointments(business_id,id),
  foreign key (business_id,pet_id) references pets(business_id,id),
  check ((state='pending') or (size_bytes is not null and sha256 is not null))
);

-- The appointment detail reads every stored photo for one appointment, grouped by
-- pet and phase, oldest first so a set reads in the order it was taken.
create index appointment_photo_set
  on appointment_photos(business_id,appointment_id,pet_id,phase,created_at,id)
  where state='stored';

-- Reserved-but-never-completed rows are reclaimable; this is the only index that
-- has to find them.
create index appointment_photo_pending
  on appointment_photos(created_at,id) where state='pending';

alter table appointment_photos enable row level security;
create policy tenant_isolation on appointment_photos
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

commit;
