begin;

create table scheduling_request_replays (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  operation text not null check (operation in ('appointment.create','appointment.reschedule')),
  idempotency_key text not null check (
    length(idempotency_key) between 16 and 128
    and idempotency_key ~ '^[A-Za-z0-9_-]+$'
  ),
  canonical_payload_hash text not null check (canonical_payload_hash ~ '^[0-9a-f]{64}$'),
  canonicalization_version text not null check (
    canonicalization_version in ('appointment.create:v1','appointment.reschedule:v1')
  ),
  initiating_actor_id uuid not null references users(id),
  result_schema_version text,
  resulting_appointment_id uuid,
  resulting_appointment_version integer,
  result_start_at timestamptz,
  result_end_at timestamptz,
  result_scheduling_timezone text,
  result_scheduled_local_start timestamp without time zone,
  result_disambiguation text check (result_disambiguation is null or result_disambiguation in ('earlier','later')),
  result_utc_offset_minutes integer,
  result_employee_id uuid,
  result_location_id uuid,
  result_conflict_detected boolean,
  result_conflict_override_requested boolean,
  result_conflict_override_authorized boolean,
  result_conflict_override_applied boolean,
  result_availability_override_applied boolean,
  completed_at timestamptz,
  minimum_retain_until timestamptz not null default (now() + interval '1 year'),
  created_at timestamptz not null default now(),
  unique (business_id,operation,idempotency_key),
  foreign key (business_id,resulting_appointment_id) references appointments(business_id,id),
  foreign key (business_id,result_employee_id) references employees(business_id,id),
  foreign key (business_id,result_location_id) references locations(business_id,id),
  check (resulting_appointment_version is null or resulting_appointment_version > 0),
  check (result_start_at is null or result_end_at > result_start_at),
  check (
    (completed_at is null
      and result_schema_version is null
      and resulting_appointment_id is null
      and resulting_appointment_version is null
      and result_start_at is null and result_end_at is null
      and result_scheduling_timezone is null and result_scheduled_local_start is null
      and result_utc_offset_minutes is null and result_employee_id is null and result_location_id is null
      and result_conflict_detected is null and result_conflict_override_requested is null and result_conflict_override_authorized is null
      and result_conflict_override_applied is null and result_availability_override_applied is null)
    or
    (completed_at is not null
      and result_schema_version in ('appointment.create.result:v1','appointment.reschedule.result:v1')
      and resulting_appointment_id is not null
      and resulting_appointment_version is not null
      and result_start_at is not null and result_end_at is not null
      and result_scheduling_timezone is not null and result_scheduled_local_start is not null
      and result_utc_offset_minutes is not null and result_employee_id is not null and result_location_id is not null
      and result_conflict_detected is not null and result_conflict_override_requested is not null and result_conflict_override_authorized is not null
      and result_conflict_override_applied is not null and result_availability_override_applied is not null)
  )
);

create or replace function prevent_completed_scheduling_replay_update()
returns trigger language plpgsql as $$
begin
  if old.completed_at is not null then
    raise integrity_constraint_violation using message='Completed scheduling replay records are immutable';
  end if;
  return new;
end
$$;

create trigger scheduling_replay_immutable
before update or delete on scheduling_request_replays
for each row execute function prevent_completed_scheduling_replay_update();

alter table scheduling_request_replays enable row level security;
create policy tenant_scheduling_request_replays on scheduling_request_replays
using (business_id = nullif(current_setting('app.business_id', true),'')::uuid)
with check (business_id = nullif(current_setting('app.business_id', true),'')::uuid);

insert into schema_migrations(version) values ('0008_scheduling_replay');

commit;
