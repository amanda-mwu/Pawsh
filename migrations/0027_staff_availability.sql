begin;

-- ---------------------------------------------------------------------------
-- Staff availability: per-weekday limits, per-date staff overrides, and
-- per-location closure days.
--
-- Read this before changing `appointment_limit`. Concurrency in Pawsh is not an
-- application rule; it is hard-enforced at one by four database objects:
--   * `enforce_employee_schedule_conflict`            (0002)
--   * `enforce_appointment_employee_conflict`         (0015)
--   * `enforce_assigned_employee_schedule_conflict`   (0015)
--   * the `one_groomer_per_appointment` unique index  (0017)
-- Each rejects any overlap outright, and the only escape is the
-- `app.scheduling_conflict_override_appointment_id` setting gated on
-- `appointments.override_conflict`. Storing a limit above one would therefore
-- record a promise the database refuses to keep: honouring it needs
-- peak-concurrency sweep semantics in all three triggers, which is a separate
-- piece of work. The column is stored now so the setting has somewhere to live
-- and the grid has something to read; the API constrains it to one.
--
-- The default of one is not a new rule. It states what the triggers have
-- enforced since 0002, so no existing row is retroactively invalidated.
-- ---------------------------------------------------------------------------

alter table employee_working_hours
  add column appointment_limit smallint not null default 1
    check (appointment_limit between 1 and 10);

-- ---------------------------------------------------------------------------
-- A single date's staff availability, which REPLACES the weekday default rather
-- than merging with it. A row with `working = false` is a day off; a row with
-- `working = true` is that day's hours in full, and the weekday row is not
-- consulted at all.
--
-- Two things it deliberately cannot do, both enforced in the resolution helper
-- rather than here: it does not reopen a salon closure day, and it does not
-- clear a blocked time. Those subtract from availability after this table has
-- had its say.
-- ---------------------------------------------------------------------------
create table employee_date_availability (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  employee_id uuid not null,
  local_date date not null,

  working boolean not null,
  -- Wall-clock in the LOCATION's timezone, never UTC. An availability window has
  -- no meaning as an instant: 09:00 is 09:00 on both sides of a DST transition.
  start_time time,
  end_time time,
  appointment_limit smallint not null default 1
    check (appointment_limit between 1 and 10),
  note text,

  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (business_id, id),
  unique (employee_id, local_date),
  foreign key (business_id, employee_id) references employees(business_id, id) on delete cascade,

  -- Either a working day with a complete, ordered window, or a day off with no
  -- window at all. A half-populated row would be a day whose hours the resolver
  -- could only guess at.
  constraint employee_date_availability_window check (
    (working and start_time is not null and end_time is not null and start_time < end_time)
    or (not working and start_time is null and end_time is null)
  )
);

-- The calendar asks "who is available on this date", not "what does this one
-- groomer do all year", so the date leads the index.
create index employee_date_availability_lookup
  on employee_date_availability (business_id, local_date, employee_id);

-- ---------------------------------------------------------------------------
-- Days a shop is shut, scoped to the LOCATION and not to the business. A
-- two-shop salon closing one of them for a flood is not closing both, and a
-- business-wide table could not express the difference.
--
-- A closure is terminal: it refuses booking even when the caller asks for an
-- availability override, because "the salon is closed" is a fact about the
-- premises rather than a preference about a groomer's hours.
-- ---------------------------------------------------------------------------
create table location_closure_days (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  location_id uuid not null,
  -- A calendar date in the location's own timezone. Deriving it from an instant
  -- on the client would put the shop's closure on the wrong day for anyone
  -- browsing from another zone.
  local_date date not null,
  reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),

  unique (business_id, id),
  unique (location_id, local_date),
  foreign key (business_id, location_id) references locations(business_id, id)
);

-- ---------------------------------------------------------------------------
-- Tenant isolation. The `tenant_isolation` loop in 0001 is a one-time `do`
-- block over a fixed array: it does not and cannot cover a table created later.
-- Both new tables therefore enable RLS and declare the policy explicitly, with
-- `using` and `with check` so a cross-tenant write is refused as firmly as a
-- cross-tenant read.
-- ---------------------------------------------------------------------------
alter table employee_date_availability enable row level security;
create policy tenant_isolation on employee_date_availability
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

alter table location_closure_days enable row level security;
create policy tenant_isolation on location_closure_days
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

insert into schema_migrations(version) values ('0027_staff_availability');
commit;
