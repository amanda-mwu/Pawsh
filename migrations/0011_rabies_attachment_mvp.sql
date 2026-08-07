begin;

-- New MVP attachments are promoted directly after bounded validation. Historical
-- scanner states remain queryable and are never newly created.
create or replace function enforce_pet_document_lifecycle() returns trigger language plpgsql as $$
begin
  if new.business_id <> old.business_id or new.pet_id <> old.pet_id
    or new.document_type <> old.document_type or new.document_version <> old.document_version
    or new.original_filename <> old.original_filename
    or new.safe_download_filename <> old.safe_download_filename
    or new.storage_key <> old.storage_key or new.content_type <> old.content_type
    or new.document_date is distinct from old.document_date
    or new.uploaded_by <> old.uploaded_by or new.created_at <> old.created_at
  then raise exception 'pet document evidence identity is immutable'; end if;
  if old.request_id is not null and new.request_id is null and new.state=old.state
    and new.size_bytes is not distinct from old.size_bytes and new.sha256 is not distinct from old.sha256
    and new.expires_on is not distinct from old.expires_on
    and new.object_uploaded_at is not distinct from old.object_uploaded_at and new.updated_at=old.updated_at
  then return new; end if;
  if old.state='superseded' then raise exception 'superseded pet documents are immutable';
  elsif old.state='rejected' then raise exception 'rejected pet documents are immutable';
  elsif old.state='current' then
    if new.state <> 'superseded' or new.size_bytes is distinct from old.size_bytes
      or new.sha256 is distinct from old.sha256 or new.expires_on is distinct from old.expires_on
      or new.object_uploaded_at is distinct from old.object_uploaded_at
    then raise exception 'current pet document permits only supersession'; end if;
  elsif old.state='pending' and new.state not in ('pending','current','pending_scan') then
    raise exception 'invalid pending pet document transition';
  elsif old.state='pending_scan' and new.state not in ('pending_scan','current','rejected') then
    raise exception 'invalid scanned pet document transition';
  end if;
  return new;
end $$;

commit;
