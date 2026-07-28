begin;

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create type membership_status as enum ('invited', 'active', 'disabled');
create type appointment_status as enum ('scheduled', 'checked_in', 'in_service', 'completed', 'cancelled', 'no_show');
create type invoice_status as enum ('draft', 'open', 'partially_paid', 'paid', 'void');
create type payment_status as enum ('recorded', 'voided');

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  normalized_email text not null unique,
  password_hash text not null,
  email_verified_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  currency char(3) not null default 'USD',
  tax_rate_basis_points integer not null default 0 check (tax_rate_basis_points between 0 and 10000),
  reminder_lead_minutes integer not null default 1440 check (reminder_lead_minutes >= 0),
  status text not null default 'active' check (status in ('active', 'disabled', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table business_memberships (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  user_id uuid not null references users(id),
  is_owner boolean not null default false,
  permissions text[] not null default '{}',
  status membership_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, user_id)
);

create table platform_administrators (
  user_id uuid primary key references users(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table membership_invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  email text not null,
  normalized_email text not null,
  token_hash text not null unique,
  permissions text[] not null default '{}',
  invited_by uuid not null references users(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, normalized_email)
);

create unique index one_owner_membership_per_business_user
  on business_memberships (business_id, user_id) where is_owner;

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null,
  address text,
  timezone text not null default 'America/Los_Angeles',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);

create unique index one_active_location_per_business
  on locations (business_id) where active;

create table business_hours (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  location_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  check (start_time < end_time),
  foreign key (business_id, location_id) references locations(business_id, id),
  unique (location_id, weekday)
);

create table employees (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  membership_id uuid references business_memberships(id),
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, membership_id)
);

create table employee_working_hours (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  employee_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  check (start_time < end_time),
  foreign key (business_id, employee_id) references employees(business_id, id) on delete cascade,
  unique (employee_id, weekday)
);

create table services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null,
  description text,
  base_duration_minutes integer not null check (base_duration_minutes > 0),
  base_price_minor integer not null check (base_price_minor >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);

create table employee_services (
  business_id uuid not null references businesses(id),
  employee_id uuid not null,
  service_id uuid not null,
  primary key (employee_id, service_id),
  foreign key (business_id, employee_id) references employees(business_id, id) on delete cascade,
  foreign key (business_id, service_id) references services(business_id, id) on delete cascade
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  first_name text not null,
  last_name text not null,
  phone text,
  normalized_phone text,
  email text,
  normalized_email text,
  address text,
  preferred_contact_method text check (preferred_contact_method in ('email', 'phone', 'none')),
  email_allowed boolean not null default true,
  notes text,
  archived_at timestamptz,
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);

create index customer_search_name on customers (business_id, lower(last_name), lower(first_name));
create index customer_search_phone on customers (business_id, normalized_phone);
create index customer_search_email on customers (business_id, normalized_email);

create table pets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  customer_id uuid not null,
  name text not null,
  species text not null default 'dog',
  breed text,
  date_of_birth date,
  approximate_age text,
  weight_ounces integer check (weight_ounces is null or weight_ounces >= 0),
  sex text,
  coat_notes text,
  grooming_preferences text,
  behavior_notes text,
  medical_notes text,
  safety_alerts text,
  emergency_contact text,
  veterinarian text,
  vaccination_notes text,
  vaccination_expires_on date,
  photo_key text,
  photo_permission boolean,
  archived_at timestamptz,
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, customer_id, id),
  foreign key (business_id, customer_id) references customers(business_id, id)
);

create table blocked_times (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  employee_id uuid not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  check (start_at < end_at),
  foreign key (business_id, employee_id) references employees(business_id, id)
);

create index pet_search_name on pets (business_id,lower(name));
create index pet_customer on pets (business_id,customer_id) where archived_at is null;

create table appointments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  location_id uuid not null,
  customer_id uuid not null,
  pet_id uuid not null,
  employee_id uuid not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status appointment_status not null default 'scheduled',
  notes text,
  operational_notes text,
  availability_overridden boolean not null default false,
  version integer not null default 1,
  created_by uuid not null references users(id),
  updated_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_at < end_at),
  unique (business_id, id),
  foreign key (business_id, location_id) references locations(business_id, id),
  foreign key (business_id, customer_id) references customers(business_id, id),
  foreign key (business_id, customer_id, pet_id) references pets(business_id, customer_id, id),
  foreign key (business_id, employee_id) references employees(business_id, id)
);

alter table appointments add constraint employee_appointment_no_overlap
  exclude using gist (
    business_id with =,
    employee_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('scheduled', 'checked_in', 'in_service'));

create index appointment_calendar on appointments (business_id, start_at, end_at);
create index appointment_employee_calendar on appointments (business_id,employee_id,start_at);

create table appointment_services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  appointment_id uuid not null,
  service_id uuid not null,
  service_name_snapshot text not null,
  duration_minutes_snapshot integer not null check (duration_minutes_snapshot > 0),
  price_minor_snapshot integer not null check (price_minor_snapshot >= 0),
  foreign key (business_id, appointment_id) references appointments(business_id, id) on delete cascade,
  foreign key (business_id, service_id) references services(business_id, id)
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null default ('INV-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  business_id uuid not null references businesses(id),
  appointment_id uuid not null,
  customer_id uuid not null,
  status invoice_status not null default 'draft',
  subtotal_minor integer not null default 0 check (subtotal_minor >= 0),
  discount_minor integer not null default 0 check (discount_minor >= 0),
  tax_minor integer not null default 0 check (tax_minor >= 0),
  tip_minor integer not null default 0 check (tip_minor >= 0),
  total_minor integer not null default 0 check (total_minor >= 0),
  balance_minor integer not null default 0 check (balance_minor >= 0),
  discount_type text,
  discount_actor uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, invoice_number),
  foreign key (business_id, appointment_id) references appointments(business_id, id),
  foreign key (business_id, customer_id) references customers(business_id, id)
);

create unique index one_active_invoice_per_appointment
  on invoices (appointment_id) where status <> 'void';
create index invoice_outstanding on invoices (business_id,status,created_at)
  where status in ('open','partially_paid');

create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  invoice_id uuid not null,
  description text not null,
  quantity integer not null default 1 check (quantity > 0),
  unit_price_minor integer not null check (unit_price_minor >= 0),
  amount_minor integer not null check (amount_minor >= 0),
  source_appointment_service_id uuid references appointment_services(id),
  foreign key (business_id, invoice_id) references invoices(business_id, id) on delete cascade
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  invoice_id uuid not null,
  amount_minor integer not null check (amount_minor > 0),
  method text not null check (method in ('cash', 'external_card', 'check', 'other')),
  status payment_status not null default 'recorded',
  external_reference text,
  recorded_by uuid not null references users(id),
  recorded_at timestamptz not null default now(),
  voided_by uuid references users(id),
  voided_at timestamptz,
  void_reason text,
  foreign key (business_id, invoice_id) references invoices(business_id, id)
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id),
  actor_id uuid references users(id),
  action text not null,
  resource_type text not null,
  resource_id uuid,
  correlation_id uuid not null,
  before_data jsonb,
  after_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create table product_analytics_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id),
  user_id uuid references users(id),
  event_name text not null,
  resource_id uuid,
  properties jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

create index product_analytics_business_time
  on product_analytics_events (business_id,occurred_at desc);

create index audit_business_time on audit_events (business_id, created_at desc);

create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  event_type text not null,
  actor_id uuid references users(id),
  resource_id uuid,
  correlation_id uuid not null,
  payload jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text
);

create index outbox_pending on outbox_events (next_attempt_at)
  where processed_at is null;

create table notification_intents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  appointment_id uuid,
  customer_id uuid,
  notification_type text not null,
  scheduled_occurrence timestamptz not null,
  channel text not null check (channel in ('email')),
  destination text not null,
  encrypted_body text,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  provider_message_id text,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index unique_appointment_notification
  on notification_intents (business_id,appointment_id,notification_type,scheduled_occurrence,channel)
  where appointment_id is not null;

create index notification_delivery_claim
  on notification_intents (scheduled_occurrence, updated_at)
  where status in ('pending', 'failed', 'sending');

create table notification_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  notification_intent_id uuid not null references notification_intents(id),
  attempt_number integer not null,
  outcome text not null,
  provider_reference text,
  error text,
  created_at timestamptz not null default now(),
  unique (notification_intent_id, attempt_number)
);

create or replace function prevent_last_owner_loss() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.is_owner and old.status = 'active'
     and not exists (
       select 1 from business_memberships m
       where m.business_id = old.business_id
         and m.id <> old.id
         and m.is_owner
         and m.status = 'active'
     )
  then
    raise exception 'cannot remove or disable the final business owner';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if old.is_owner and old.status = 'active'
     and (not new.is_owner or new.status <> 'active')
     and not exists (
       select 1 from business_memberships m
       where m.business_id = old.business_id
         and m.id <> old.id
         and m.is_owner
         and m.status = 'active'
     )
  then
    raise exception 'cannot remove or disable the final business owner';
  end if;
  return new;
end $$;

create trigger protect_last_owner
  before update or delete on business_memberships
  for each row execute function prevent_last_owner_loss();

-- Defense-in-depth policies use a transaction-local tenant context set by the API.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'business_memberships','locations','business_hours','employees','employee_working_hours',
    'membership_invitations',
    'services','employee_services','customers','pets','blocked_times','appointments',
    'appointment_services','invoices','invoice_items','payments','audit_events',
    'outbox_events','notification_intents','notification_delivery_attempts',
    'product_analytics_events'
  ]
  loop
    execute format('alter table %I enable row level security', table_name);
    execute format(
      'create policy tenant_isolation on %I using (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid) with check (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)',
      table_name
    );
  end loop;
end $$;

insert into schema_migrations(version) values ('0001_initial');
commit;
