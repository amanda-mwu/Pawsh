begin;

-- ---------------------------------------------------------------------------
-- Gives roles a STATED order instead of an alphabetical one.
--
-- The roles list ordered by `built_in desc, lower(name)`, which put the three
-- built-ins on screen as Groomer, Manager, Receptionist - the most powerful of
-- them in the middle, purely because of how its name is spelled. The top staff
-- role belongs directly under the Owner, and nothing about "Manager" sorting
-- after "Groomer" was ever a decision.
--
-- Worse, it was a decision nobody could see being made wrongly. A built-in
-- added later - an "Assistant", a "Bather" - would have landed wherever its
-- first letter put it, and no test could have caught a position that was never
-- written down anywhere. `sort_order` writes it down: `builtInRoles` in
-- `packages/domain/src/permissions.ts` is the source, `provisionRoleCatalog`
-- gives every business created from now on the same positions this backfills,
-- and reordering that array is the whole of how the order changes.
--
-- The column follows `payment_methods.sort_order` from 0034 exactly - integer,
-- not null, spaced in tens so a role can be inserted between two others without
-- renumbering, and paired with an index over the ordering the list actually
-- uses.
--
-- CUSTOM ROLES KEEP AN ALPHABETICAL ORDER, and that is deliberate rather than
-- an omission. Pawsh has no opinion about where a salon's own "Front desk"
-- belongs relative to its "Weekend cover", so they share one value that sorts
-- after every built-in and fall back to `lower(name)` between themselves. It is
-- the column default, so a role created through the API lands there without the
-- route having to say anything about order.
-- ---------------------------------------------------------------------------

alter table roles add column sort_order integer not null default 100;

-- Only roles this product named. A salon's own role called "Manager" is
-- `built_in = false` and is left where the custom roles sort, because it is
-- theirs - 0041 rule 3 kept exactly those, and renaming or repositioning one
-- here would be Pawsh reaching into a salon's own naming.
--
-- A built-in an owner has since RENAMED also keeps the default. It no longer
-- matches by name, it is theirs now, and guessing which of the three it used to
-- be from its permissions would be a worse answer than the alphabet.
update roles
set sort_order = case lower(name)
    when 'manager' then 10
    when 'groomer' then 20
    when 'receptionist' then 30
  end
where built_in
  and lower(name) in ('manager', 'groomer', 'receptionist');

create index role_order on roles (business_id, sort_order, lower(name));

insert into schema_migrations(version) values ('0044_role_sort_order');
commit;
