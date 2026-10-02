begin;

-- ---------------------------------------------------------------------------
-- The shipped Receptionist keeps seeing how to reach the client.
--
-- `customers.contact_info` stops being a switch that does nothing. From this
-- change a client's phone, email and postal address leave the server only
-- for a member holding the key (or the owner): every projection that carries
-- one nulls it and says `contactWithheld: true`, and every write of one is
-- refused. The Receptionist preset holds the key; this file gives it to every
-- built-in Receptionist that already exists, so the desk does not lose the
-- phone number it books by the moment the key starts biting - the silent
-- revocation 0043, 0045 and 0055 were each written to prevent.
--
-- THE GROOMER DOES NOT GAIN IT. A groomer works the dog in front of them; the
-- client's name, the pet and its care stay on every appointment surface, and
-- how to reach the client does not. An owner who wants a groomer to see it
-- grants the switch in the editor.
--
-- A DATA MIGRATION AND NOTHING ELSE: no column, no index, no row deleted, and
-- its only statement is an UPDATE against `roles` that grants and never
-- revokes.
--
-- NOMINAL, NOT RELATIONAL, following 0057's step 2 and 0058. A built-in's
-- name IS its identity - the roles API refuses to rename one - so `built_in`
-- and the name together are the only honest way to say "the Receptionist
-- Pawsh shipped". A custom role named "Receptionist" or "Front desk" means
-- whatever the owner made it mean and is not touched. The Manager already
-- holds every key. An owner is unaffected: ownership short-circuits every
-- check.
--
-- IDEMPOTENT, INCLUDING THE VERSION BUMP. The predicate excludes roles that
-- already hold the key, so a second pass matches nothing and moves no
-- `version`. The bump on a role that did change is deliberate, for 0043's and
-- 0045's reason: an editor holding the old copy must be refused rather than
-- allowed to write the grant back out.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The shipped Receptionist sees the client's contact details.
-- ---------------------------------------------------------------------------
update roles
set permissions = (
    select array_agg(distinct permission order by permission)
    from unnest(permissions || array['customers.contact_info']) as permission
  ),
  version = version + 1,
  updated_at = now()
where built_in and lower(name) = 'receptionist'
  and not (permissions @> array['customers.contact_info']::text[]);


-- ---------------------------------------------------------------------------
-- What is true once this has run: every built-in Receptionist holds the key.
-- That no Groomer and no custom role gained it is not assertable from here,
-- so `tests/database/receptionist-contact-info-migration-0059.test.ts` pins
-- it by planting both and asserting they come out unchanged.
-- ---------------------------------------------------------------------------
do $$
declare
  stranded bigint;
begin
  select count(*) into stranded from roles
  where built_in and lower(name) = 'receptionist'
    and not (permissions @> array['customers.contact_info']::text[]);
  if stranded > 0 then
    raise exception '% built-in Receptionist roles were left without customers.contact_info', stranded;
  end if;
end $$;

commit;
