begin;

-- ---------------------------------------------------------------------------
-- Vaccination attachments
--
-- A vaccination record can carry the certificate it came from — a photo of the
-- card the vet handed over, or a PDF the practice emailed.
--
-- These do not go in `pet_documents`. That table is rabies evidence: PDF only,
-- one current record per pet per type, an immutability trigger, and a
-- supersession lifecycle whose expiry drives whether an appointment can go
-- ahead. A photo of a Bordetella card carries none of that weight, and a pet can
-- hold several such records at once.
--
-- Rabies keeps its existing home. The interface offers one "add vaccine" dialog
-- for both, and routes a rabies entry to the pet's care record and its document
-- rather than creating a row here, so there is still exactly one answer to
-- "is this dog covered?".
-- ---------------------------------------------------------------------------

-- Never populated: it pointed at `pet_documents`, which cannot hold these files.
alter table pet_vaccinations drop column document_id;

alter table pet_vaccinations
  add column document_storage_key text unique,
  add column document_content_type text check (document_content_type is null
    or document_content_type in ('application/pdf','image/jpeg','image/png','image/webp')),
  add column document_filename text check (document_filename is null
    or char_length(document_filename) between 1 and 180),
  add column document_size_bytes bigint check (document_size_bytes is null or document_size_bytes > 0),
  add column document_sha256 text check (document_sha256 is null or document_sha256 ~ '^[0-9a-f]{64}$'),
  add column document_uploaded_at timestamptz,
  -- Either the whole attachment is there or none of it is. A row describing a file
  -- with no key behind it would render a broken link for good.
  add constraint pet_vaccination_document_complete check (
    (document_storage_key is null and document_content_type is null
      and document_filename is null and document_size_bytes is null
      and document_sha256 is null and document_uploaded_at is null)
    or (document_storage_key is not null and document_content_type is not null
      and document_filename is not null and document_size_bytes is not null
      and document_sha256 is not null and document_uploaded_at is not null)
  );

commit;
