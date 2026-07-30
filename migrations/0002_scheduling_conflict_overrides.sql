alter table appointments
  add column conflict_overridden boolean not null default false;

alter table appointments
  drop constraint employee_appointment_no_overlap;

create or replace function enforce_employee_schedule_conflict()
returns trigger
language plpgsql
as $$
declare
  override_appointment_id text;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(new.business_id::text || ':' || new.employee_id::text, 0)
  );

  if new.status not in ('scheduled', 'checked_in', 'in_service') then
    return new;
  end if;

  override_appointment_id :=
    nullif(current_setting('app.scheduling_conflict_override_appointment_id', true), '');

  if exists (
    select 1
    from appointments existing
    where existing.business_id = new.business_id
      and existing.employee_id = new.employee_id
      and existing.id <> new.id
      and existing.status in ('scheduled', 'checked_in', 'in_service')
      and tstzrange(existing.start_at, existing.end_at, '[)')
          && tstzrange(new.start_at, new.end_at, '[)')
  ) and override_appointment_id is distinct from new.id::text then
    raise exclusion_violation using
      message = 'The employee already has an overlapping appointment',
      constraint = 'employee_appointment_no_overlap';
  end if;

  return new;
end
$$;

create trigger employee_appointment_conflict_guard
before insert or update of business_id, employee_id, start_at, end_at, status
on appointments
for each row execute function enforce_employee_schedule_conflict();

insert into schema_migrations(version) values ('0002_scheduling_conflict_overrides');
