begin;

-- ---------------------------------------------------------------------------
-- Tax and payment configuration.
--
-- Three things a salon configures and one it cannot.
--
-- TAX RATES. `businesses.tax_rate_basis_points` stays the authority every invoice snapshots at
-- creation. This table does not replace it: it names the rates a salon keeps and marks exactly
-- one of them as the one in force, and the API mirrors that rate onto the business row inside
-- the same transaction. Invoicing therefore reads what it has always read, and the settings
-- screen stops being a second, disagreeing answer to "what tax do we charge".
--
-- PAYMENT METHODS. `payments.method` is a closed set of four settlement types - cash,
-- external_card, check, other - because that is what the ledger can actually distinguish. A
-- salon's own list is longer than four ("Square Terminal", "Zelle") and is presentation over
-- that set, so every configured method must name the settlement type it records as. That is the
-- link between a method and its payment type, and it is a foreign key to nothing: the four
-- values are a check constraint here exactly as they are on `payments`.
--
-- CARD PROCESSORS. A salon may record which processor it uses, its location label, its
-- processing fees, its tip defaults and its terminal devices. It may NOT connect one. Pawsh has
-- no OAuth flow, no credential store, no tokenization and no PCI scope, so there is no
-- connected state to represent and no column here that could claim one. `card_processors` is
-- configuration a salon keeps for its own reference; a terminal row is an inventory record of a
-- device that exists on the counter, not a paired session. When a real integration lands it
-- will add its own credential and pairing tables, and nothing recorded here will have to be
-- retracted as a fabrication.
-- ---------------------------------------------------------------------------

create table tax_rates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- Basis points, matching `businesses.tax_rate_basis_points`. 10000 is 100%, which is absurd
  -- for tax but is the honest upper bound of the unit rather than an invented ceiling.
  rate_basis_points integer not null check (rate_basis_points between 0 and 10000),
  is_default boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);

create unique index tax_rate_name_per_business on tax_rates (business_id, lower(btrim(name)));
-- At most one rate in force per business: the mirror onto `businesses` has to be unambiguous.
create unique index tax_rate_single_default on tax_rates (business_id) where is_default;

create table payment_methods (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  -- The settlement type this method records as. Identical to the `payments.method` set: a
  -- configured method is a label over one of the four things the ledger can tell apart.
  settlement_type text not null
    check (settlement_type in ('cash', 'external_card', 'check', 'other')),
  enabled boolean not null default true,
  sort_order integer not null default 0,
  -- A method may name the processor it settles through. Free text rather than a foreign key:
  -- the salon may run a terminal Pawsh has no configuration row for, and refusing the label
  -- would push it into the method name.
  processor_label text check (processor_label is null or char_length(btrim(processor_label)) between 1 and 60),
  -- Built-in methods are the four settlement types themselves. They may be disabled and
  -- reordered but never deleted, because deleting one would leave recorded payments of that
  -- type with no method to display.
  built_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);

create unique index payment_method_name_per_business on payment_methods (business_id, lower(btrim(name)));
create index payment_method_order on payment_methods (business_id, sort_order, id);

create table card_processors (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  provider text not null
    check (provider in ('square', 'stripe', 'clover_cardpointe', 'authorize_net')),
  is_default boolean not null default false,
  -- What the salon calls the account or location that takes the money. A label only: Pawsh
  -- cannot read a location list from a provider it does not talk to.
  location_label text check (location_label is null or char_length(btrim(location_label)) between 1 and 80),
  -- Three tip presets, whole percents. Checkout offers them; they are not a charge.
  tip_percent_1 smallint not null default 15 check (tip_percent_1 between 0 and 100),
  tip_percent_2 smallint not null default 18 check (tip_percent_2 between 0 and 100),
  tip_percent_3 smallint not null default 20 check (tip_percent_3 between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, provider)
);

create unique index card_processor_single_default on card_processors (business_id) where is_default;

create table card_processor_fees (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  processor_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  -- A processing fee is a percentage plus a flat amount: "2.6% + 10c" is one row, not two.
  rate_basis_points integer not null check (rate_basis_points between 0 and 10000),
  cent_amount_minor integer not null default 0 check (cent_amount_minor between 0 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id, processor_id) references card_processors(business_id, id) on delete cascade
);

create index card_processor_fee_owner on card_processor_fees (business_id, processor_id, name);

create table card_processor_terminals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  processor_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  location_label text check (location_label is null or char_length(btrim(location_label)) between 1 and 80),
  -- The device code printed on the terminal. Recorded so staff can tell two machines apart;
  -- Pawsh does not send it anywhere, because there is nowhere to send it.
  device_code text check (device_code is null or char_length(btrim(device_code)) between 1 and 40),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id, processor_id) references card_processors(business_id, id) on delete cascade
);

create index card_processor_terminal_owner on card_processor_terminals (business_id, processor_id, name);

-- ---------------------------------------------------------------------------
-- Existing businesses start configured rather than empty: the four settlement types as enabled
-- built-in methods, and their current tax rate as the rate in force. A salon opening this
-- screen for the first time sees what it has been charging and taking, not a blank slate that
-- implies neither was ever set.
-- ---------------------------------------------------------------------------

insert into payment_methods (business_id, name, settlement_type, enabled, sort_order, built_in)
select business.id, method.name, method.settlement_type, true, method.sort_order, true
from businesses business
cross join (values
  ('Cash', 'cash', 10),
  ('Card', 'external_card', 20),
  ('Check', 'check', 30),
  ('Other', 'other', 40)
) as method(name, settlement_type, sort_order);

insert into tax_rates (business_id, name, rate_basis_points, is_default)
select id,
  case when tax_rate_basis_points = 0 then 'No tax' else 'Sales tax' end,
  tax_rate_basis_points,
  true
from businesses;

insert into schema_migrations(version) values ('0034_tax_and_payment_settings');
commit;
