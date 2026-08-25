begin;

-- Multi-location businesses need more than one active shop, so the historical
-- single-active-location invariant no longer holds. Deterministic selection is
-- guaranteed by the session's chosen location with a (name,id) fallback instead.
drop index if exists one_active_location_per_business;

-- The session owns the working location the same way it already owns the
-- working business. Nullable so pre-existing sessions keep working and fall
-- back to the deterministic default until the user chooses.
alter table sessions add column location_id uuid;

-- Composite reference so a session can never point at a location owned by a
-- different business. MATCH SIMPLE leaves legacy rows with a null business_id
-- unconstrained here; read-side resolution still scopes by business_id.
alter table sessions
  add constraint sessions_location_within_business
  foreign key (business_id,location_id) references locations(business_id,id);

update sessions session
set location_id=(
  select location.id from locations location
  where location.business_id=session.business_id and location.active
  order by location.name,location.id limit 1
)
where session.location_id is null and session.business_id is not null;

create index sessions_location on sessions(location_id) where location_id is not null;

insert into schema_migrations(version) values ('0018_session_location_selection');
commit;
