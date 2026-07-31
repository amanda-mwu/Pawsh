begin;

create table pet_documents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  pet_id uuid not null,
  document_type text not null check (document_type in ('rabies_vaccination')),
  state text not null check (state in ('pending','current','superseded')),
  document_version integer not null default 1 check (document_version > 0),
  original_filename text not null check (char_length(original_filename) between 1 and 180),
  safe_download_filename text not null check (char_length(safe_download_filename) between 1 and 180),
  storage_key text not null unique,
  content_type text not null check (content_type = 'application/pdf'),
  size_bytes bigint,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  document_date date,
  expires_on date,
  uploaded_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  object_uploaded_at timestamptz,
  unique (business_id,id),
  foreign key (business_id,pet_id) references pets(business_id,id),
  check ((state='pending') or (size_bytes is not null and sha256 is not null and object_uploaded_at is not null))
);

create unique index one_current_pet_document
  on pet_documents(business_id,pet_id,document_type) where state='current';
create index pet_document_history
  on pet_documents(business_id,pet_id,document_type,created_at desc,id desc)
  where state in ('current','superseded');
create index pet_document_pending
  on pet_documents(created_at,id) where state='pending';

create table pet_document_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  pet_id uuid not null,
  operation text not null check (operation in ('upload','replace')),
  upload_request_id uuid not null,
  metadata_fingerprint text not null check (metadata_fingerprint ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('in_progress','completed','failed','conflict')),
  result_document_id uuid,
  result_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  recovery_after timestamptz not null default (now() + interval '1 hour'),
  unique (business_id,pet_id,operation,upload_request_id),
  foreign key (business_id,pet_id) references pets(business_id,id),
  foreign key (business_id,result_document_id) references pet_documents(business_id,id),
  check ((state='completed' and result_document_id is not null and completed_at is not null)
      or (state<>'completed' and result_document_id is null))
);

create index pet_document_request_cleanup
  on pet_document_requests(updated_at,id);

alter table pet_documents
  add column request_id uuid unique references pet_document_requests(id) on delete set null;

create function enforce_pet_document_lifecycle() returns trigger language plpgsql as $$
begin
  if new.business_id <> old.business_id or new.pet_id <> old.pet_id
    or new.document_type <> old.document_type or new.document_version <> old.document_version
    or new.original_filename <> old.original_filename
    or new.safe_download_filename <> old.safe_download_filename
    or new.storage_key <> old.storage_key or new.content_type <> old.content_type
    or new.document_date is distinct from old.document_date
    or new.uploaded_by <> old.uploaded_by or new.created_at <> old.created_at
  then
    raise exception 'pet document evidence identity is immutable';
  end if;
  if old.request_id is not null and new.request_id is null
    and new.state=old.state and new.size_bytes is not distinct from old.size_bytes
    and new.sha256 is not distinct from old.sha256
    and new.expires_on is not distinct from old.expires_on
    and new.object_uploaded_at is not distinct from old.object_uploaded_at
    and new.updated_at=old.updated_at
  then
    return new;
  end if;
  if old.state='superseded' then
    raise exception 'superseded pet documents are immutable';
  end if;
  if old.state='current' then
    if new.state <> 'superseded'
      or new.size_bytes is distinct from old.size_bytes
      or new.sha256 is distinct from old.sha256
      or new.expires_on is distinct from old.expires_on
      or new.object_uploaded_at is distinct from old.object_uploaded_at
    then
      raise exception 'current pet document permits only supersession';
    end if;
  elsif old.state='pending' and new.state not in ('pending','current') then
    raise exception 'invalid pending pet document transition';
  end if;
  return new;
end $$;

create trigger pet_document_lifecycle_guard
  before update on pet_documents
  for each row execute function enforce_pet_document_lifecycle();

alter table pet_documents enable row level security;
create policy tenant_isolation on pet_documents
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

alter table pet_document_requests enable row level security;
create policy tenant_isolation on pet_document_requests
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

commit;
