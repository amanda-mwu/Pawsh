begin;

-- ---------------------------------------------------------------------------
-- Pet profile
--
-- The pet record grows from a handful of grooming fields into the profile a
-- salon actually keeps: how the coat is kept, a note thread with authorship,
-- photographs over time, structured medical information, the vet's details, and
-- the vaccinations on file.
-- ---------------------------------------------------------------------------

-- 1. Identity and grooming fields --------------------------------------------
--
-- `mixed_breed` is a nullable boolean on purpose: unknown and "no" are different
-- answers, and defaulting to false would record one nobody gave.
--
-- `approximate_age_*` sit alongside `date_of_birth` rather than replacing it.
-- A birthday is a fact; "about two years old" is an estimate the salon was told,
-- and collapsing the estimate into a fabricated birthday would make it
-- indistinguishable from one the owner actually stated.
alter table pets
  add column mixed_breed boolean,
  add column hair_length text,
  add column coat_color text,
  -- Spayed, neutered, and intact are what a salon actually records, and the first
  -- two also carry the sex. A boolean would flatten three answers into two and
  -- lose that, so the vocabulary is stored rather than a yes/no.
  add column fixed_status text check (fixed_status is null
    or fixed_status in ('spayed','neutered','intact')),
  add column preferred_shampoo text,
  add column approximate_age_years smallint check (approximate_age_years is null
    or (approximate_age_years between 0 and 60)),
  add column approximate_age_months smallint check (approximate_age_months is null
    or (approximate_age_months between 0 and 11)),
  -- A pet that has died stays on the record: its history, invoices, and report
  -- cards all still have to be explainable. It is marked, not deleted.
  add column deceased_at timestamptz;

-- 2. Medical information -----------------------------------------------------
--
-- NULL means nobody has been asked. An empty array means somebody was asked and
-- there is nothing to report. Those are different facts and the interface says so.
--
-- The vocabulary deliberately excludes rabies. Pawsh already records rabies
-- status authoritatively on the pet and in its documents, and a tick box saying
-- "Rabies Shot" would be a second, unverified place where the same question is
-- answered — the one thing a compliance record cannot afford.
alter table pets
  add column health_issues text[] check (
    health_issues is null or health_issues <@ array[
      'diabetes_mellitus','epilepsy','heart_condition','arthritis','obesity',
      'distemper','fleas_ticks_mites','cancer','blind','deaf'
    ]::text[]
  );

-- 3. Vet information ---------------------------------------------------------
--
-- The legacy free-text `veterinarian` and `emergency_contact` columns are copied
-- into the structured fields and then left alone. They are user-authored content;
-- nothing is dropped, and a deployment that rolls back still reads what it wrote.
alter table pets
  add column vet_name text,
  add column vet_phone text,
  add column vet_contact_name text,
  add column vet_contact_phone text,
  add column vet_address text;

update pets set vet_name = nullif(btrim(veterinarian), '') where veterinarian is not null;
update pets set vet_contact_name = nullif(btrim(emergency_contact), '')
  where emergency_contact is not null;

-- 4. Note thread -------------------------------------------------------------
--
-- Mirrors `customer_notes`: every entry records who wrote it and when, because a
-- grooming instruction nobody can be asked about is not much use six months later.
create table pet_notes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  pet_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  pinned boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, pet_id) references pets(business_id, id) on delete cascade
);

create index pet_note_thread on pet_notes (business_id, pet_id, created_at desc, id desc);
create index pet_note_pinned on pet_notes (business_id, pet_id) where pinned;

-- The single free-text grooming note that predates this thread becomes its first
-- entry rather than being stranded in a column nothing renders any more.
insert into pet_notes (business_id, pet_id, body, created_by, created_at, updated_at)
select business_id, id, btrim(grooming_preferences), updated_by, updated_at, updated_at
from pets
where grooming_preferences is not null and btrim(grooming_preferences) <> '';

-- 5. Photographs -------------------------------------------------------------
--
-- The same shape as `appointment_photos`, and for the same reasons: two states,
-- no scan state because there is no scanner, and the content type constrained
-- here as well as in the route because these bytes are served back inline.
create table pet_photos (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  pet_id uuid not null,
  state text not null check (state in ('pending','stored')),
  storage_key text not null unique,
  content_type text not null check (content_type in ('image/jpeg','image/png','image/webp')),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  size_bytes bigint check (size_bytes is null or size_bytes > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  original_filename text not null check (char_length(original_filename) between 1 and 180),
  upload_request_id uuid not null,
  uploaded_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, pet_id, upload_request_id),
  foreign key (business_id, pet_id) references pets(business_id, id) on delete cascade,
  check ((state='pending') or (size_bytes is not null and sha256 is not null))
);

create index pet_photo_gallery
  on pet_photos (business_id, pet_id, created_at desc, id desc) where state='stored';
create index pet_photo_pending on pet_photos (created_at, id) where state='pending';

-- The avatar is a pointer into the gallery, not a separate upload. Deleting the
-- photograph clears the avatar rather than leaving the profile pointing at bytes
-- that are gone — but that clearing is done explicitly by the delete handler, not
-- by `on delete set null`. The reference is composite, and the cascade would set
-- every column in it, including the `not null` business_id.
alter table pets add column avatar_photo_id uuid,
  add constraint pet_avatar_photo
    foreign key (business_id, avatar_photo_id) references pet_photos(business_id, id);

-- 6. Vaccination records -----------------------------------------------------
--
-- Rabies is excluded by constraint. It already has an authoritative home on the
-- pet and in `pet_documents`, with expiry driving appointment eligibility and
-- customer notifications; a second row claiming a different rabies date would
-- make the compliance answer ambiguous. The interface renders the real rabies
-- record alongside these and sends edits to the place that owns it.
create table pet_vaccinations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  pet_id uuid not null,
  vaccine text not null check (
    char_length(btrim(vaccine)) between 1 and 80
    and lower(btrim(vaccine)) <> 'rabies'
  ),
  expires_on date,
  document_id uuid,
  notes text check (notes is null or char_length(notes) <= 2000),
  version integer not null default 1 check (version > 0),
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, pet_id) references pets(business_id, id) on delete cascade,
  foreign key (business_id, document_id) references pet_documents(business_id, id)
);

create index pet_vaccination_list
  on pet_vaccinations (business_id, pet_id, expires_on desc nulls last, id);

alter table pet_notes enable row level security;
create policy tenant_isolation on pet_notes
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

alter table pet_photos enable row level security;
create policy tenant_isolation on pet_photos
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

alter table pet_vaccinations enable row level security;
create policy tenant_isolation on pet_vaccinations
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

commit;
