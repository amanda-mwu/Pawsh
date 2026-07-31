alter table locations add column version integer not null default 1 check (version > 0);

alter table appointments
  add column scheduling_timezone text,
  add column scheduled_local_start timestamp without time zone,
  add column scheduled_utc_offset_minutes integer,
  add column scheduled_disambiguation text check (scheduled_disambiguation in ('earlier','later'));

update appointments a set
  scheduling_timezone=l.timezone,
  scheduled_local_start=a.start_at at time zone l.timezone,
  scheduled_utc_offset_minutes=extract(epoch from ((a.start_at at time zone l.timezone)-(a.start_at at time zone 'UTC')))/60
from locations l where l.id=a.location_id;

alter table appointments
  alter column scheduling_timezone set not null,
  alter column scheduled_local_start set not null,
  alter column scheduled_utc_offset_minutes set not null;

create index appointment_location_local_calendar
  on appointments(business_id,location_id,scheduled_local_start);

alter table blocked_times
  add column location_id uuid,
  add column scheduling_timezone text,
  add column scheduled_local_start timestamp without time zone,
  add column scheduled_local_end timestamp without time zone;

update blocked_times bt set location_id=l.id,scheduling_timezone=l.timezone,
  scheduled_local_start=bt.start_at at time zone l.timezone,
  scheduled_local_end=bt.end_at at time zone l.timezone
from locations l where l.business_id=bt.business_id and l.active;

alter table blocked_times
  alter column location_id set not null,
  alter column scheduling_timezone set not null,
  alter column scheduled_local_start set not null,
  alter column scheduled_local_end set not null,
  add foreign key (business_id,location_id) references locations(business_id,id);

insert into schema_migrations(version) values ('0007_calendar_time_integrity');
