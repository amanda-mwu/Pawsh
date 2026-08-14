alter table customers
  add column preferred_employee_id uuid;

alter table customers
  add constraint customer_preferred_employee_tenant_fk
  foreign key (business_id, preferred_employee_id)
  references employees(business_id, id);

create index customer_preferred_employee
  on customers(business_id, preferred_employee_id)
  where preferred_employee_id is not null;
