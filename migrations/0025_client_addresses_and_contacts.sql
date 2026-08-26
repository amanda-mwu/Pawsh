begin;

-- ---------------------------------------------------------------------------
-- Client addresses and contacts
--
-- A client is rarely one address and one phone number. There is the house and
-- the second home, the owner and the partner and the dog walker who actually
-- does the pick-up. Both lists carry exactly one primary, enforced by a partial
-- unique index rather than by hoping the interface only ever ticks one.
-- ---------------------------------------------------------------------------

create table customer_addresses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  customer_id uuid not null,
  label text check (label is null or char_length(btrim(label)) between 1 and 60),
  address text not null check (char_length(btrim(address)) between 1 and 500),
  is_primary boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, customer_id) references customers(business_id, id) on delete cascade
);

create unique index one_primary_customer_address
  on customer_addresses (business_id, customer_id) where is_primary;
create index customer_address_list
  on customer_addresses (business_id, customer_id, is_primary desc, created_at, id);

create table customer_contacts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  customer_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  phone text not null check (char_length(btrim(phone)) between 1 and 40),
  normalized_phone text,
  title text check (title is null or char_length(btrim(title)) between 1 and 80),

  -- Stored, and deliberately not acted on. Pawsh sends email and has no SMS
  -- transport, and a contact here carries a phone number and no address, so
  -- there is nothing this flag could currently drive. It is recorded because the
  -- salon knows the answer today and should not have to collect it again later;
  -- the interface says plainly that nothing reads it yet.
  receives_automated_messages boolean not null default true,

  is_primary boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, customer_id) references customers(business_id, id) on delete cascade
);

create unique index one_primary_customer_contact
  on customer_contacts (business_id, customer_id) where is_primary;
create index customer_contact_list
  on customer_contacts (business_id, customer_id, is_primary desc, created_at, id);
create index customer_contact_phone
  on customer_contacts (business_id, normalized_phone) where normalized_phone is not null;

-- The existing single address becomes the client's primary address rather than
-- being stranded in a column the new panel does not render.
insert into customer_addresses (business_id, customer_id, address, is_primary, created_by, created_at)
select business_id, id, btrim(address), true, updated_by, created_at
from customers
where address is not null and btrim(address) <> '';

-- `customers.address` stays as a derived mirror of the primary, the same way
-- `customers.notes` mirrors the note thread. Existing readers keep working and
-- the two cannot drift, because only one of them is ever written by hand.
create function sync_customer_primary_address() returns trigger language plpgsql as $$
declare
  target_business uuid := coalesce(new.business_id, old.business_id);
  target_customer uuid := coalesce(new.customer_id, old.customer_id);
begin
  update customers set address = (
    select address from customer_addresses
    where business_id = target_business and customer_id = target_customer and is_primary
    limit 1
  )
  where business_id = target_business and id = target_customer;
  return null;
end $$;

create trigger customer_primary_address_mirror
  after insert or update or delete on customer_addresses
  for each row execute function sync_customer_primary_address();

alter table customer_addresses enable row level security;
create policy tenant_isolation on customer_addresses
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

alter table customer_contacts enable row level security;
create policy tenant_isolation on customer_contacts
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

commit;
