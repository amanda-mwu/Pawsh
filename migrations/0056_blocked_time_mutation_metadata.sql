begin;

-- ---------------------------------------------------------------------------
-- `blocked_times` learns who changed it and when, because from the next change
-- on it can BE changed.
--
-- The table has carried `created_by` and `created_at` since 0001 and nothing
-- else about authorship, which was honest while a block was write-once: there
-- was no second writer to name. 0055 gave it a `version` for optimistic
-- concurrency and said in as many words that nothing bumps it yet; the edit and
-- delete routes land in the change this file belongs to, and the moment a row
-- can be rewritten, "who wrote what is in it now" stops being answerable from
-- `created_by`.
--
-- THE PAIR IS THE ESTABLISHED SPELLING, NOT A NEW ONE. Every mutable record in
-- this schema carries the same four columns in the same order -
-- `created_by` / `updated_by` / `created_at` / `updated_at` - and the versioned
-- ones carry them NOT NULL: `appointments` (0001), `appointment_report_cards`
-- (0022). `customers` and `pets` keep the nullable form because their
-- `created_by` is nullable too and an imported row has no author to name.
-- `blocked_times.created_by` is `not null`, so this table belongs with the
-- first group: every row has an author, therefore every row can name a last
-- writer, therefore the column can be `not null` and a reader never has to
-- handle an absent one.
--
-- ADD NULLABLE, BACKFILL, THEN CONSTRAIN - 0007's sequence on this very table,
-- and the only one that works on a table with rows in it.
--
-- THE BACKFILL IS `created_*`, NOT `now()`, AND THAT IS THE WHOLE POINT OF
-- DOING IT IN TWO STEPS. `add column ... timestamptz not null default now()`
-- would have been one line and would have stamped every block that has ever
-- been written with the moment this migration ran, so a calendar that has not
-- been touched since March would report that all of it was edited at deploy
-- time. A row that has never been updated was last written when it was created,
-- by whoever created it. That is true, it is derivable, and it is what these two
-- statements record. The same reasoning is why `version` defaults to 1 rather
-- than being backfilled from an edit count nobody has.
--
-- NOTHING IS DELETED OR MOVED. Two additive columns, two updates that only fill
-- the nulls those columns arrived with, and three constraint tightenings.
--
-- IDEMPOTENT, following 0052 and 0055: the columns are added `if not exists`,
-- the backfills are `where ... is null` so a re-run matches nothing, and
-- `set not null` / `set default` are no-ops against a column that already has
-- them. What `if not exists` cannot see is a column of the right name and the
-- WRONG TYPE, so the closing block checks shapes rather than names.
--
-- NO TRIGGER, DELIBERATELY. `updated_at` is moved by the writer in the same
-- statement as the change it describes, exactly as `version` is and exactly as
-- `appointments`, `roles` and `locations` do it. A trigger here would be the
-- only invisible one in this database and would fire for writes nobody expected
-- it to fire for - including the backfill above.
-- ---------------------------------------------------------------------------

alter table blocked_times
  add column if not exists updated_by uuid references users(id),
  add column if not exists updated_at timestamptz;

update blocked_times set updated_by = created_by where updated_by is null;
update blocked_times set updated_at = created_at where updated_at is null;

alter table blocked_times
  alter column updated_by set not null,
  alter column updated_at set not null,
  -- The default matters only for a row inserted by a writer that does not name
  -- the column. `POST /api/blocked-times` does not, so every block created from
  -- here on gets `now()` for its `updated_at` and its `created_at` alike, which
  -- is the truth about a row that has been written once.
  alter column updated_at set default now();


-- ---------------------------------------------------------------------------
-- What was true when this ran.
--
-- THE SHAPES, because `if not exists` would have skipped a column of the right
-- name and the wrong type in silence and every later reader would inherit it.
--
-- AND THE BACKFILL'S OWN PROPERTY: no block may claim to have been updated
-- before it was created. That is the assertion that fails if somebody ever
-- replaces the two updates above with a `default now()` on a table whose rows
-- predate the deploy - the failure mode this file was written to avoid - and it
-- goes on holding as a general invariant for every row written afterwards.
-- ---------------------------------------------------------------------------
do $$
declare
  shape text;
  offenders bigint;
begin
  select data_type || ' ' || is_nullable into shape from information_schema.columns
  where table_name = 'blocked_times' and column_name = 'updated_by';
  if shape is distinct from 'uuid NO' then
    raise exception 'blocked_times.updated_by is %, expected a not-null uuid', coalesce(shape, 'absent');
  end if;

  select data_type || ' ' || is_nullable into shape from information_schema.columns
  where table_name = 'blocked_times' and column_name = 'updated_at';
  if shape is distinct from 'timestamp with time zone NO' then
    raise exception 'blocked_times.updated_at is %, expected a not-null timestamptz', coalesce(shape, 'absent');
  end if;

  select count(*) into offenders from blocked_times where updated_at < created_at;
  if offenders > 0 then
    raise exception '% blocked times were left claiming to have been updated before they were created', offenders;
  end if;
end $$;

commit;
