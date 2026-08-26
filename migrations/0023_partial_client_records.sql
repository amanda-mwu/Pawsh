begin;

-- ---------------------------------------------------------------------------
-- Partial client records
--
-- Somebody rings up to ask about a groom, gives a phone number and the breed,
-- and hangs up before booking. Until now that call could not be written down:
-- a client needed a first name and a last name, and a pet needed a name, so the
-- only way to record the enquiry was to invent something.
--
-- Unknown is stored as NULL, never as a placeholder like 'Not Set' or '?'. A
-- placeholder is indistinguishable from a real value once it is in the column —
-- it sorts, it matches searches, it exports, and a year later nobody can tell
-- which records were genuinely called that. The interface renders "Not set" for
-- a null; the database keeps saying it does not know.
--
-- What a record must still have is one way to identify or reach the person. A
-- row with no name, no phone, and no email is not a partial client, it is an
-- empty row, and it would be unfindable the moment it was saved.
-- ---------------------------------------------------------------------------

alter table customers
  alter column first_name drop not null,
  alter column last_name drop not null;

-- Blank is the same as unknown, and allowing both would mean every read had to
-- handle two spellings of the same absence.
alter table customers
  add constraint customer_names_are_absent_or_meaningful check (
    (first_name is null or btrim(first_name) <> '')
    and (last_name is null or btrim(last_name) <> '')
  ),
  add constraint customer_is_identifiable check (
    first_name is not null or last_name is not null
    or normalized_phone is not null or normalized_email is not null
  );

alter table pets
  alter column name drop not null;

alter table pets
  add constraint pet_name_is_absent_or_meaningful check (
    name is null or btrim(name) <> ''
  );

commit;
