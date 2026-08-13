begin;

create table appointment_employees (
  business_id uuid not null references businesses(id),
  appointment_id uuid not null,
  employee_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (appointment_id,employee_id),
  foreign key (business_id,appointment_id) references appointments(business_id,id) on delete cascade,
  foreign key (business_id,employee_id) references employees(business_id,id)
);
create index appointment_employee_assignments_calendar
  on appointment_employees(business_id,employee_id,appointment_id);

insert into appointment_employees(business_id,appointment_id,employee_id)
select business_id,id,employee_id from appointments on conflict do nothing;

create or replace function enforce_appointment_employee_conflict()
returns trigger language plpgsql as $$
declare booked appointments%rowtype; override_id text;
begin
  select * into booked from appointments where id=new.appointment_id;
  perform pg_advisory_xact_lock(hashtextextended(new.business_id::text || ':' || new.employee_id::text,0));
  if booked.status not in ('scheduled','checked_in','in_service') then return new; end if;
  override_id:=nullif(current_setting('app.scheduling_conflict_override_appointment_id',true),'');
  if exists(
    select 1 from appointment_employees assignment join appointments existing on existing.id=assignment.appointment_id
    where assignment.business_id=new.business_id and assignment.employee_id=new.employee_id
      and existing.id<>new.appointment_id and existing.status in ('scheduled','checked_in','in_service')
      and tstzrange(existing.start_at,existing.end_at,'[)') && tstzrange(booked.start_at,booked.end_at,'[)')
  ) and override_id is distinct from new.appointment_id::text then
    raise exclusion_violation using message='The employee already has an overlapping appointment',constraint='appointment_employee_no_overlap';
  end if;
  return new;
end $$;
create trigger appointment_employee_conflict_guard before insert or update on appointment_employees
for each row execute function enforce_appointment_employee_conflict();

create or replace function enforce_assigned_employee_schedule_conflict()
returns trigger language plpgsql as $$
declare assigned uuid; override_id text;
begin
  if new.status not in ('scheduled','checked_in','in_service') then return new; end if;
  override_id:=nullif(current_setting('app.scheduling_conflict_override_appointment_id',true),'');
  for assigned in select employee_id from appointment_employees where appointment_id=new.id loop
    perform pg_advisory_xact_lock(hashtextextended(new.business_id::text || ':' || assigned::text,0));
    if exists(select 1 from appointment_employees ae join appointments existing on existing.id=ae.appointment_id
      where ae.business_id=new.business_id and ae.employee_id=assigned and existing.id<>new.id
        and existing.status in ('scheduled','checked_in','in_service')
        and tstzrange(existing.start_at,existing.end_at,'[)') && tstzrange(new.start_at,new.end_at,'[)'))
      and override_id is distinct from new.id::text then
      raise exclusion_violation using message='The employee already has an overlapping appointment',constraint='appointment_employee_no_overlap';
    end if;
  end loop;
  return new;
end $$;
create trigger assigned_employee_schedule_conflict_guard
before update of start_at,end_at,status on appointments for each row execute function enforce_assigned_employee_schedule_conflict();

alter table appointment_employees enable row level security;
create policy tenant_isolation on appointment_employees
  using (business_id=nullif(current_setting('app.business_id',true),'')::uuid)
  with check (business_id=nullif(current_setting('app.business_id',true),'')::uuid);

update services set active=false,updated_at=now()
where seed_key='ear-cleaning-plucking' and active;

insert into services
  (business_id,name,description,base_duration_minutes,base_price_minor,category,pricing_mode,seed_key,active)
select business.id,'Ear Cleaning','Pawsh default service',10,1000,'A_LA_CARTE','FIXED','ear-cleaning',true
from businesses business
on conflict (business_id,seed_key) where seed_key is not null do update
set name=excluded.name,base_duration_minutes=excluded.base_duration_minutes,active=true,updated_at=now();

insert into services
  (business_id,name,description,base_duration_minutes,base_price_minor,category,pricing_mode,seed_key,active)
select business.id,'Ear Plucking','Pawsh default service',10,1000,'A_LA_CARTE','FIXED','ear-plucking',true
from businesses business
on conflict (business_id,seed_key) where seed_key is not null do update
set name=excluded.name,base_duration_minutes=excluded.base_duration_minutes,active=true,updated_at=now();

with duplicates as (
  select id,row_number() over (
    partition by business_id,lower(regexp_replace(btrim(name),'\s+',' ','g'))
    order by created_at,id
  ) position
  from services where active
)
update services set active=false,updated_at=now()
where id in (select id from duplicates where position>1);

create unique index one_active_normalized_service_name
  on services (business_id,lower(regexp_replace(btrim(name),'\s+',' ','g'))) where active;

alter table scheduling_request_replays
  drop constraint scheduling_request_replays_canonicalization_version_check;
alter table scheduling_request_replays
  add constraint scheduling_request_replays_canonicalization_version_check check (
    canonicalization_version in (
      'appointment.create:v1','appointment.reschedule:v1',
      'appointment.create:v2','appointment.reschedule:v2'
    )
  );

insert into schema_migrations(version) values ('0015_multi_groomer_booking');
commit;
