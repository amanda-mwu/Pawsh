begin;

-- ---------------------------------------------------------------------------
-- `blocked_times` becomes something an operator can MANAGE, not only create.
--
-- The table has been enforceable since 0001 and unmanageable ever since. It has
-- one write path (`POST /api/blocked-times`), no read path until the calendar
-- got one, and no way at all to change or remove a row once it exists: an
-- operator who blocked the wrong groomer's Tuesday had to ask somebody with a
-- database client. This file adds the three things management needs - a colour,
-- a concurrency token and the index the reads have been going without - and
-- grants the permissions that gate it. The edit and delete ROUTES land in the
-- next change; the schema they need lands here, so that change is about
-- behaviour rather than about a migration.
--
-- NOTHING HERE REWRITES, MOVES OR DELETES A ROW. Both columns are nullable or
-- defaulted, the index is additive, and the only UPDATE is against `roles`,
-- where it grants and never revokes.
--
-- THE WHOLE FILE IS IDEMPOTENT, following 0052: both columns are added
-- `if not exists`, the index is created `if not exists`, and the role grant
-- excludes roles it has already reached, so re-running it is a no-op down to
-- the version numbers - and a re-run that bumped every role's version would
-- invalidate an editor somebody had open for no reason. The one thing
-- `if not exists` cannot see is a column of the same name and a DIFFERENT type,
-- so the closing block checks the shapes rather than only the names.
--
-- NO RECURRENCE COLUMN, DELIBERATELY. "Every Tuesday" is the obvious next ask
-- and it is not being half-built here. Pawsh has no recurrence concept anywhere
-- - not in the schema, not in the domain, not in the API - and a
-- `recurrence_rule` added speculatively would be a column with no writer, no
-- reader and no expansion engine, which every later reader would have to decide
-- whether to trust. One Time is the only state a block has. Recurrence is a
-- design of its own, with its own decisions about expansion, exceptions, and
-- what an edit to a single occurrence means, and it gets its own record when
-- somebody makes them.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. `color_slot`: which identity colour the calendar paints this block in.
--
-- PRESENTATION METADATA AND NOTHING ELSE. It changes no scheduling decision; a
-- block refuses exactly the same bookings whatever colour it is. It exists
-- because a grid carrying four blocks - a lunch, a vet run, a deep clean, a
-- training afternoon - reads as four identical grey bands, and colour is how an
-- operator tells them apart at a glance from across the room.
--
-- COPIED FROM `employees.color_slot` (0040) DOWN TO THE BOUND, because Pawsh
-- must have one way of storing a colour rather than two. A SLOT, NEVER A HEX:
-- storing `#7C5CBF` would put a literal colour in the database that no theme
-- could restyle, that dark mode could not adapt, and that would drift from the
-- `--groomer-N` tokens the calendar actually paints with the first time a
-- designer touched them. The slot names a token; the token owns the colour.
--
-- THE CHECK IS THE DURABLE OUTER BOUND (0-15) AND NOT THE PALETTE. The palette
-- has ten named tokens today (`--groomer-1` .. `--groomer-10`: Violet, Steel
-- blue, Teal, Amber, Olive, Plum, Bark, Indigo, Clay, Petrol) and
-- `groomerPaletteSize` in the domain package is the real ceiling every write is
-- validated against. 0040 said why the two differ and it holds here unchanged:
-- growing the palette to twelve should be a constant and a stylesheet, not a
-- migration on a table with rows in it. A slot stored while the palette was
-- wider than it is now is ignored by the client rather than rendered, exactly as
-- a groomer's is.
--
-- NULLABLE, AND NULL IS THE ORDINARY CASE. Every block written before this file
-- has no colour and none is invented for it: null means "nobody chose", which
-- the calendar renders as the default band it has always drawn. A backfill
-- dealing colours out by hash would recolour every existing block on every
-- existing calendar in order to say nothing.
--
-- No unique index, for 0040's reason: this is a label, not an identity, and two
-- blocks in one week sharing a colour is fine and often deliberate.
-- ---------------------------------------------------------------------------
alter table blocked_times
  add column if not exists color_slot smallint
    check (color_slot is null or color_slot between 0 and 15);


-- ---------------------------------------------------------------------------
-- 2. `version`: optimistic concurrency, so a stale edit is refused rather than
--    silently applied.
--
-- LAST-WRITE-WINS WAS CONSIDERED AND REJECTED. A block is a SCHEDULING
-- CONSTRAINT: while it stands, the availability authority refuses every booking
-- that touches it. Two managers with the same block open - one shortening it to
-- free up 12:30, one moving it to Wednesday - resolved by whoever clicks last
-- means the loser's screen goes on showing a constraint that is not there any
-- more, and the bookings they then take or refuse are decided by a rule nobody
-- is looking at. That is the class of lost update the version columns on
-- `appointments`, `roles`, `locations` and `appointment_report_cards` all exist
-- to prevent, and a blocked time is not the place to start making an exception.
--
-- THE CONVENTION IS COPIED EXACTLY FROM THOSE FOUR, so the schema has one way of
-- doing this rather than five:
--
--   * `integer not null default 1 check (version > 0)` - the spelling 0022 and
--     0041 use. The default is what backfills every existing row: a block that
--     has never been edited is at version 1, which is true of every row in this
--     table the moment this runs.
--   * The column is bumped BY THE WRITER, in the same statement as the change
--     (`set ..., version = version + 1`), never by a trigger. Every other
--     versioned table in this schema does it that way - including the role
--     grants in 0043 and 0045, which bump it from inside a plain UPDATE - and a
--     trigger here would be the only invisible one in the database, firing for
--     writes nobody expected it to fire for.
--   * The caller sends back the version it read, and a mismatch is a 409 saying
--     to refresh - the answer `PUT /api/appointments/:id/services` and the
--     report-card edit already give.
--
-- NOTHING BUMPS IT YET, AND THAT IS CORRECT. No route changes a block as this
-- lands, so every row sits at 1 and the column is inert. It is here now because
-- the alternative is a migration in the middle of the change that adds the edit
-- routes, where a schema change and a behaviour change would have to be reviewed
-- as one thing.
-- ---------------------------------------------------------------------------
alter table blocked_times
  add column if not exists version integer not null default 1 check (version > 0);


-- ---------------------------------------------------------------------------
-- 3. The index the calendar read has been going without.
--
-- `blocked_times` carries a primary key on `id` and NOTHING ELSE - nothing on
-- the tenant, nothing on the location, nothing on time. Every read of it is
-- therefore a sequential scan of every block every salon has ever written, and
-- there are two such reads per calendar paint now: the availability authority's
-- step-5 subtraction, and the calendar's own range read.
--
-- `(business_id, location_id, start_at)` matches how both of them ask. The
-- calendar read's predicate is `business_id = $1 and location_id = $2 and
-- start_at < $3 and end_at > $4`, so the two equalities lead and the range
-- follows - the shape a btree answers with one descent and a scan of a few
-- days' leaves, and exactly what `appointment_calendar` and
-- `appointment_employee_calendar` (0001) do for the appointments drawn beside
-- these blocks.
--
-- WHY `start_at` AND NOT `end_at`. Only one of a half-open overlap's two bounds
-- can be indexed usefully: `end_at > $4` is unbounded above and would have the
-- scan run to the end of time. `start_at < $3` is the selective half - it stops
-- at the window's close, and the handful of rows that started earlier and run
-- into the window are filtered on `end_at` on the way past.
--
-- WHY NOT LEAD WITH `employee_id`. The groomer filter is OPTIONAL - the calendar
-- sends it only when a filter is on - and an index whose leading column the
-- commonest query does not constrain answers that query no better than no index
-- at all. The location, by contrast, is in every read of this table: one shop's
-- lunch break is not the other shop's.
--
-- `if not exists` so re-running this file is a no-op.
-- ---------------------------------------------------------------------------
create index if not exists blocked_time_location_calendar
  on blocked_times (business_id, location_id, start_at);


-- ---------------------------------------------------------------------------
-- 4. THE BACKFILL: everyone who can block time out today can still block time
--    out tomorrow.
--
-- The two dedicated keys arrived with the taxonomy in 0045 and have gated
-- nothing since, while `POST /api/blocked-times` has been gated on
-- `appointments.edit` since it was written. This change moves that route onto
-- the dedicated key, which is what the pair was reserved for - and moving it
-- WITHOUT this statement would take the capability away from every role holding
-- `appointments.edit` and not the pair, silently, in every workspace that
-- already exists.
--
-- THE RECEPTIONIST IS THE ROLE THAT MAKES THIS NECESSARY, and it is not
-- hypothetical. That preset holds `appointments.edit` and holds NEITHER of the
-- two keys: 0045 granted the taxonomy only to roles that already held all 46
-- permissions, which a Receptionist is nowhere near. So a front desk that has
-- been blocking out lunches since the feature shipped would have found the
-- button refusing them, with no release note and no error that explained itself.
-- Blocking out time is front-desk work; that it is now a switch of its own does
-- not make it manager-only. The shipped presets gain the same two keys in the
-- same change, so a salon that signs up tomorrow and a salon migrated by this
-- file get the same Receptionist.
--
-- THE PREDICATE IS RELATIONAL, NOT NOMINAL, following 0043's
-- `where 'reports.view' = any(permissions)` and 0045's containment test: "every
-- role that can create a block today". Matching on a role NAME would miss a
-- built-in an owner renamed - which they are free to do - and would miss every
-- custom role a salon built for its own front desk, which is most of them.
-- `appointments.edit` IS the capability being migrated off, so holding it is the
-- honest test of who would otherwise lose something.
--
-- WHAT NOBODY GAINS. The Groomer preset holds no `appointments.edit` and could
-- not create a block before this file; it holds none afterwards and still
-- cannot. An owner is unaffected in both directions - ownership is a flag on the
-- membership, not a permission set, and the permission check short-circuits on
-- it. So the set of people who can block out time is IDENTICAL either side of
-- this migration, which is the whole point of it.
--
-- BOTH KEYS, NOT ONLY THE CREATE ONE. Its twin gates the change and delete
-- routes landing next. Granting them in one statement, to one set of roles,
-- keeps "can block time out" a single capability rather than a pair that drifts
-- apart between two releases - and a role that may create a block but not fix
-- the one it just got wrong is not a coherent thing to ship.
--
-- IDEMPOTENT, INCLUDING THE VERSION BUMP. The second half of the predicate
-- excludes roles that already hold both keys, so a re-run matches no rows at all
-- rather than matching them, adding nothing through `array_agg(distinct ...)`
-- and bumping `version` anyway. 0045 needed no such clause because it ran once;
-- a migration test applies this one twice.
-- ---------------------------------------------------------------------------
update roles
set permissions = (
    select array_agg(distinct permission order by permission)
    from unnest(
      permissions || array['calendar.blocks_create', 'calendar.blocks_edit']
    ) as permission
  ),
  -- The role changed, so its optimistic-concurrency token moves with it, for the
  -- same reason 0043 and 0045 moved it: an editor holding the old version must
  -- be told its copy is stale rather than being allowed to write these grants
  -- back out.
  version = version + 1,
  updated_at = now()
where 'appointments.edit' = any(permissions)
  and not (permissions @> array['calendar.blocks_create', 'calendar.blocks_edit']::text[]);


-- ---------------------------------------------------------------------------
-- What was true when this ran.
--
-- THE GRANT IS A SILENT-REVOCATION GUARD, so the property worth asserting is the
-- one it exists to hold: after this file, no role can hold `appointments.edit`
-- without also holding the pair. A role left behind would be a front desk that
-- quietly lost its button - precisely the failure this migration was written to
-- prevent - and it would be found by an operator rather than by a deploy.
--
-- AND THE COLUMNS ARE CHECKED BY SHAPE, NOT BY NAME, which is the price of the
-- `if not exists` that makes this file re-runnable: a column of the right name
-- and the wrong type would have been skipped silently, and every later reader
-- would inherit it.
-- ---------------------------------------------------------------------------
do $$
declare
  stranded bigint;
  shape text;
begin
  select count(*) into stranded from roles
  where 'appointments.edit' = any(permissions)
    and not (permissions @> array['calendar.blocks_create', 'calendar.blocks_edit']::text[]);
  if stranded > 0 then
    raise exception '% roles can edit appointments but were left unable to block out time', stranded;
  end if;

  select data_type || ' ' || is_nullable into shape from information_schema.columns
  where table_name = 'blocked_times' and column_name = 'color_slot';
  if shape is distinct from 'smallint YES' then
    raise exception 'blocked_times.color_slot is %, expected a nullable smallint', coalesce(shape, 'absent');
  end if;

  select data_type || ' ' || is_nullable into shape from information_schema.columns
  where table_name = 'blocked_times' and column_name = 'version';
  if shape is distinct from 'integer NO' then
    raise exception 'blocked_times.version is %, expected a not-null integer', coalesce(shape, 'absent');
  end if;

  if not exists (
    select 1 from pg_indexes
    where tablename = 'blocked_times' and indexname = 'blocked_time_location_calendar'
  ) then
    raise exception 'blocked_times was left without its calendar index';
  end if;
end $$;

commit;
