begin;

-- ---------------------------------------------------------------------------
-- Tenant-qualified foreign keys.
--
-- Almost every reference between two tenant tables in this schema is written
-- as `foreign key (business_id, x_id) references target(business_id, id)`, so
-- the database itself refuses a row that points at another account's. Four
-- references were not, and pointed at the target's primary key alone. Those
-- four could be made to reference a row belonging to a different business, and
-- referential integrity checks would raise nothing, because a plain
-- `references target(id)` says nothing about whose row it is.
--
-- THIS IS NOT DEFENCE IN DEPTH; IT IS THE DEFENCE. Every table here declares
-- `enable row level security` and a `tenant_isolation` policy, and none of them
-- enforce anything today: Pawsh connects as the owner of these tables, no table
-- sets FORCE ROW LEVEL SECURITY, and PostgreSQL exempts a table's owner from
-- its own policies. 0033, 0041 and 0050 each say so in their own words. So the
-- composite foreign keys and the `where business_id = ...` predicates in the
-- API are the whole boundary, and a reference that carries no business_id is a
-- hole in it that nothing else is covering.
--
-- WHAT THIS FILE DOES NOT DO. It does not enable FORCE ROW LEVEL SECURITY -
-- that is a separate decision about a separate connection role, and turning it
-- on under the owner connection Pawsh uses today would change nothing while
-- looking as though it had changed everything.
--
-- NO ROW IS REWRITTEN, MOVED OR DELETED. Every constraint below was verified to
-- hold over the existing data before being written, and each is added as an
-- ordinary validating constraint so that a violating row - if one ever existed
-- - would fail this migration loudly rather than be admitted and hidden.
--
-- The whole file is idempotent: every DROP is `if exists`, every ADD is guarded
-- on `pg_constraint`, and every index is `if not exists`. Re-running it is a
-- no-op.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The composite identities three targets were missing.
--
-- A tenant-qualified foreign key needs `(business_id, id)` to be unique on the
-- table it points at. `business_memberships` already carries it - three times
-- over, from 0009, 0010 and 0014, which is its own small waste and is left
-- alone here rather than dropped as a side effect of an unrelated change. The
-- three targets below carry it nowhere, which is why the references into them
-- could not have been written correctly in the first place.
--
-- `appointment_services` is the notable one. It is the only table in 0001's
-- core set - `locations`, `services`, `customers`, `pets`, `appointments`,
-- `invoices` all have it - that was left without one, and it is the target of
-- the financial reference below.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'appointment_services'::regclass and conname = 'appointment_services_business_id_id_key'
  ) then
    alter table appointment_services add constraint appointment_services_business_id_id_key unique (business_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'notification_intents'::regclass and conname = 'notification_intents_business_id_id_key'
  ) then
    alter table notification_intents add constraint notification_intents_business_id_id_key unique (business_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pet_document_requests'::regclass and conname = 'pet_document_requests_business_id_id_key'
  ) then
    alter table pet_document_requests add constraint pet_document_requests_business_id_id_key unique (business_id, id);
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 2. `invoice_items.source_appointment_service_id` -> `appointment_services`.
--
-- THE FINANCIAL ONE, AND THE REASON THIS FILE EXISTS. This column is the line
-- item's pointer back to the service that produced it, and it was
-- `references appointment_services(id)` - so an invoice line in one salon could
-- name the appointment service of another. Nothing in the checkout handler
-- writes such a row: the services are read with a `business_id` predicate and
-- the line items are inserted from that same list inside one transaction. But
-- "the only writer is careful" is the argument every one of these four holes
-- rested on, and it is worth exactly as much as the next handler somebody adds.
--
-- The column stays NULLABLE and the constraint stays MATCH SIMPLE (the
-- default), so a line item that names no source - a manual line, or one whose
-- appointment service has since been replaced - is unaffected: with any column
-- of the key null, the check does not run at all.
--
-- ON DELETE stays absent, as it was. `PUT /api/appointments/:id/services`
-- deletes and reinserts `appointment_services` rows, and a delete that would
-- orphan an invoiced line must go on failing rather than quietly nulling a
-- financial record's provenance.
-- ---------------------------------------------------------------------------
alter table invoice_items drop constraint if exists invoice_items_source_appointment_service_id_fkey;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'invoice_items'::regclass and conname = 'invoice_item_source_service_tenant'
  ) then
    alter table invoice_items add constraint invoice_item_source_service_tenant
      foreign key (business_id, source_appointment_service_id)
      references appointment_services (business_id, id);
  end if;
end $$;

-- The old constraint's check could ride `appointment_services_pkey` from the
-- parent side; the new one is looked up on the CHILD by `(business_id,
-- source_appointment_service_id)`, and `invoice_items` had no index on that
-- column at all. Without this, deleting the services off an appointment - an
-- ordinary edit - scans every invoice line in the database. Partial, because a
-- line item with no source is not a row this lookup ever asks about.
create index if not exists invoice_item_source_service
  on invoice_items (business_id, source_appointment_service_id)
  where source_appointment_service_id is not null;


-- ---------------------------------------------------------------------------
-- 3. `employees.membership_id` -> `business_memberships`.
--
-- The link between a groomer on the calendar and the workspace account that is
-- that person. `unique (business_id, membership_id)` on `employees` has always
-- made the link one-to-one, but it says nothing about WHOSE membership, and the
-- reference itself was to `business_memberships(id)` alone.
--
-- The API has been carrying this since 0040 in `PATCH /api/employees/:id`,
-- which refuses a membership it cannot resolve inside the caller's own
-- business - specifically because the foreign key did not. That check stays: it
-- turns what is now a constraint violation into a coded 4xx an operator can
-- act on, and it also enforces things a foreign key cannot (the membership must
-- be active, and the account behind it must not be platform-disabled). This
-- makes the schema agree with it.
--
-- The composite key it points at already exists, so no index is created here.
-- `unique (business_id, membership_id)` supports the child-side lookup.
-- ---------------------------------------------------------------------------
alter table employees drop constraint if exists employees_membership_id_fkey;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'employees'::regclass and conname = 'employee_membership_tenant'
  ) then
    alter table employees add constraint employee_membership_tenant
      foreign key (business_id, membership_id)
      references business_memberships (business_id, id);
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 4. `notification_delivery_attempts.notification_intent_id` -> `notification_intents`.
--
-- The delivery log for an outbound message. `notification_intent_id` is NOT
-- NULL, so unlike the others this constraint is checked on every row.
--
-- `unique (notification_intent_id, attempt_number)` leads with the intent id,
-- so the child-side lookup this constraint needs is already indexed and no
-- index is added.
-- ---------------------------------------------------------------------------
alter table notification_delivery_attempts
  drop constraint if exists notification_delivery_attempts_notification_intent_id_fkey;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'notification_delivery_attempts'::regclass and conname = 'notification_delivery_attempt_tenant'
  ) then
    alter table notification_delivery_attempts add constraint notification_delivery_attempt_tenant
      foreign key (business_id, notification_intent_id)
      references notification_intents (business_id, id);
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 5. `pet_documents.request_id` -> `pet_document_requests`.
--
-- The upload request a stored document arrived through, added by 0005 as
-- `unique references pet_document_requests(id) on delete set null`.
--
-- ON DELETE SET NULL IS PRESERVED, AND HAS TO NAME ITS COLUMN. A plain
-- `on delete set null` on a two-column key nulls BOTH columns, and
-- `pet_documents.business_id` is `not null` - so the cleanup that expires old
-- requests would start failing on any request that had produced a document.
-- `on delete set null (request_id)`, PostgreSQL 15's column list, sets only the
-- half that is allowed to be empty and leaves the document in its own tenant.
-- Pawsh requires PostgreSQL 17.
--
-- `unique (request_id)` leads with the referenced column, so the child-side
-- lookup is already indexed and no index is added.
-- ---------------------------------------------------------------------------
alter table pet_documents drop constraint if exists pet_documents_request_id_fkey;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pet_documents'::regclass and conname = 'pet_document_request_tenant'
  ) then
    alter table pet_documents add constraint pet_document_request_tenant
      foreign key (business_id, request_id)
      references pet_document_requests (business_id, id)
      on delete set null (request_id);
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 6. `pet_document_requests.membership_id` -> `business_memberships`.
--
-- Already correct, and carrying a redundant twin. 0009 added the column with an
-- inline `references business_memberships(id)`, which creates its own
-- single-column constraint, and then twelve lines later added
-- `pet_document_request_actor` on `(business_id, membership_id)`. Adding the
-- second does not replace the first, so the table has carried both ever since.
--
-- The composite is strictly stronger - every row satisfying it satisfies the
-- single-column one too - so this was never an exploitable hole, only a second
-- constraint checked on every write and a non-tenant-qualified reference for
-- the next reviewer to find and re-report. It is dropped rather than kept
-- because there is nothing left for it to say.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pet_document_requests'::regclass and conname = 'pet_document_request_actor'
  ) then
    raise exception 'pet_document_request_actor is missing; refusing to drop the single-column twin';
  end if;
end $$;
alter table pet_document_requests drop constraint if exists pet_document_requests_membership_id_fkey;


-- ---------------------------------------------------------------------------
-- DELIBERATELY NOT CHANGED: `business_breed_settings.breed_id` -> `breeds`.
--
-- The sixth non-tenant-qualified reference in this schema, and the one that
-- cannot be expressed as a composite foreign key at all. `breeds.business_id`
-- is NULLABLE BY DESIGN: a null marks a row of the shared taxonomy every
-- account may use, and a business-owned breed carries its own id. A key of
-- `(business_id, breed_id)` cannot say "my row OR the shared row", so pointing
-- one at `breeds (business_id, id)` would reject every shared breed - which is
-- almost all of them.
--
-- 0033 met the same wall for `pets.breed_id` and answered it with the
-- `pet_breed_tenant` trigger, which refuses a breed owned by another business
-- and, unlike a policy, applies to the owner connection. `business_breed_settings`
-- has no equivalent. Its one writer, `PUT /api/breeds/:breedId/settings`,
-- resolves the breed through `loadBreedForTenant` first and answers 404 for
-- another tenant's, so the API predicate is the whole guard there today.
--
-- Closing that properly means a second trigger modelled on
-- `pet_breed_tenant_guard`, not a foreign key, and it is a different change
-- from this one. Recorded here so it is not rediscovered as an oversight.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- The four references this file rewrote, checked against the data as it stands.
-- Each of the constraints above validates its own table on creation, so this is
-- belt and braces rather than the enforcement - but a bare `alter table` says
-- only that the change went through, and this says what was true when it did.
-- ---------------------------------------------------------------------------
do $$
declare
  offenders bigint;
begin
  select count(*) into offenders from invoice_items item
    join appointment_services service on service.id = item.source_appointment_service_id
    where service.business_id <> item.business_id;
  if offenders > 0 then raise exception 'invoice_items references % cross-tenant appointment_services rows', offenders; end if;

  select count(*) into offenders from employees employee
    join business_memberships membership on membership.id = employee.membership_id
    where membership.business_id <> employee.business_id;
  if offenders > 0 then raise exception 'employees references % cross-tenant memberships', offenders; end if;

  select count(*) into offenders from notification_delivery_attempts attempt
    join notification_intents intent on intent.id = attempt.notification_intent_id
    where intent.business_id <> attempt.business_id;
  if offenders > 0 then raise exception 'notification_delivery_attempts references % cross-tenant intents', offenders; end if;

  select count(*) into offenders from pet_documents document
    join pet_document_requests upload on upload.id = document.request_id
    where upload.business_id <> document.business_id;
  if offenders > 0 then raise exception 'pet_documents references % cross-tenant requests', offenders; end if;
end $$;

commit;
