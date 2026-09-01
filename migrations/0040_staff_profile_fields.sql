begin;

-- ---------------------------------------------------------------------------
-- Two fields the rebuilt Settings -> Staff screen needs, and deliberately
-- nothing else.
--
-- WHAT IS NOT HERE, AND MUST NOT BE ADDED WITHOUT A PRODUCT DECISION:
--
--   * NO first/last name split. `display_name` is the one name a groomer has,
--     and it is read in roughly twenty-five places across the web client, the
--     mobile app, `packages/domain`, the seeds and `tests/database`. Splitting
--     it would fork every one of those into "which half do I show".
--
--   * NO email column. The Staff screen shows the LINKED ACCOUNT'S email, which
--     lives on `users.email` and is reached through `employees.membership_id`.
--     A column here would be a second copy with no sync path: change the email
--     in account settings and the staff card would keep showing the old one
--     forever, while the eight attribution joins kept using the membership.
--
--   * NO booking toggle. `active` is the only activation concept, and
--     `employee_working_hours` / `employee_date_availability` / 0027's closure
--     days are the only owners of WHEN a groomer is bookable.
--
-- RLS: `employees` was created in 0001 and is already covered by that file's
-- `tenant_isolation` do-block. Unlike 0027, which created new tables and
-- therefore had to declare policies itself, this migration only adds columns to
-- a table that already has one, so a new policy here would be a duplicate.
-- Composite key: `employees` already carries `unique (business_id, id)`, which
-- is what lets `employee_services`, `employee_working_hours`,
-- `employee_date_availability` and `appointment_employees` reference it in a
-- tenant-qualified way. No new table, so nothing to add.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The calendar identity colour a groomer is assigned, or null to keep the
-- hash-derived one.
--
-- The web and mobile clients both derive a colour by hashing the employee UUID
-- into a fixed number of slots (`groomerSlotIndex` in `packages/domain`). That
-- is fine for a salon with a few groomers and useless past the slot count,
-- where two people collide and nobody can do anything about it. This column
-- makes the slot assignable; null keeps the existing hash, so no workspace that
-- never touches the setting changes at all.
--
-- THE RANGE IS DELIBERATELY WIDER THAN THE PALETTE. A check pinned to the
-- palette size would need a second migration the moment a colour was added, and
-- a schema migration is a bad place to keep a design decision. So the constraint
-- is the durable outer bound -- sixteen slots, more than a calendar can render
-- distinguishably -- and the number of slots that ACTUALLY EXIST is enforced by
-- the API against `groomerPaletteSize`. Growing the palette is then a one-line
-- change in `packages/domain` with no migration.
--
-- Note that the palette size and the HASH modulus are two different numbers and
-- must stay that way: see `groomerHashSlotCount`. Widening the hash does not
-- extend the palette for the people relying on it, it redeals their colours.
--
-- Duplicates across employees are allowed on purpose: this is a label, not an
-- identity, and two groomers who never appear on the same day may reasonably
-- share a colour. There is no unique index and there must not be one.
-- ---------------------------------------------------------------------------
alter table employees
  add column color_slot smallint
    check (color_slot is null or color_slot between 0 and 15);

-- ---------------------------------------------------------------------------
-- A staff phone number, for the record only.
--
-- NOTHING DIALS OR TEXTS THIS. Pawsh has no SMS channel at all -- see
-- `AGREEMENT_CHANNEL_UNSUPPORTED` and 0020's note that the agreement outbox is
-- email-only -- and adding one is a standing product deferral. This is the
-- number an owner writes on a staff card so it is somewhere other than a
-- personal phone's contacts.
--
-- Stored exactly the way `customers.phone` and `customer_contacts.phone` are
-- stored, so the codebase has one phone convention rather than two: the typed
-- text as entered, plus a digits-only `normalized_phone` written by the same
-- `normalizePhone` helper every other phone column already goes through. The
-- normalised form is not searched today; it exists so that the day staff search
-- gains a phone match, it matches the customer directory's semantics for free
-- instead of inventing a second answer to "is 555-0100 the same as 5550100".
--
-- `normalizePhone` returns null for input with no digits at all, so a normalised
-- value without a source is impossible and the constraint says so. The reverse
-- is legitimate: text a human typed that contains no digits normalises to null.
-- ---------------------------------------------------------------------------
alter table employees
  add column phone text
    check (phone is null or char_length(btrim(phone)) between 1 and 40),
  add column normalized_phone text
    check (normalized_phone is null or normalized_phone ~ '^[0-9]+$');

alter table employees
  add constraint employee_phone_normalization
    check (normalized_phone is null or phone is not null);

insert into schema_migrations(version) values ('0040_staff_profile_fields');
commit;
