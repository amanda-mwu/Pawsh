begin;

-- The appointment row owns the authoritative groomer. Normalize legacy
-- multi-assignment rows before enforcing the MVP one-appointment/one-groomer contract.
alter table appointment_employees disable trigger appointment_employee_conflict_guard;

delete from appointment_employees assignment
using appointments appointment
where assignment.business_id=appointment.business_id
  and assignment.appointment_id=appointment.id
  and assignment.employee_id<>appointment.employee_id;

insert into appointment_employees(business_id,appointment_id,employee_id)
select business_id,id,employee_id from appointments
on conflict do nothing;

alter table appointment_employees enable trigger appointment_employee_conflict_guard;

create unique index one_groomer_per_appointment
  on appointment_employees(business_id,appointment_id);

insert into schema_migrations(version) values ('0017_single_groomer_appointments');
commit;
