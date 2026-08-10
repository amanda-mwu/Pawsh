begin;

alter table services
  add column category text not null default 'GENERAL',
  add column pricing_mode text not null default 'FIXED',
  add column seed_key text,
  add column range_max_minor integer,
  add column price_confirmation_required boolean not null default false,
  add constraint service_category_check check (category in ('GENERAL','DOG_BASE','DOG_ADDON','A_LA_CARTE','CAT')),
  add constraint service_pricing_mode_check check (pricing_mode in ('FIXED','TIERED','WEIGHT_TIER','SERVICE_TYPE_FIXED','QUOTE_REQUIRED','RANGE')),
  add constraint service_range_check check (range_max_minor is null or range_max_minor >= base_price_minor);

create unique index service_business_seed on services(business_id,seed_key) where seed_key is not null;

create table business_breeds (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  breed_key text not null,
  name text not null,
  normalized_name text not null,
  default_pricing_class text not null default 'STANDARD'
    check (default_pricing_class in ('SMOOTH_SINGLE','STANDARD','EXTRA_FLOOF')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(business_id,id),
  unique(business_id,breed_key),
  unique(business_id,normalized_name)
);

create table service_price_tiers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  service_id uuid not null,
  pricing_class text not null default 'STANDARD'
    check (pricing_class in ('SMOOTH_SINGLE','STANDARD','EXTRA_FLOOF')),
  weight_tier_code text not null
    check (weight_tier_code in ('TIER_1','TIER_2','TIER_3','TIER_4','TIER_5','TIER_6')),
  price_minor integer not null check(price_minor>=0),
  duration_minutes integer check(duration_minutes is null or duration_minutes>0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(service_id,pricing_class,weight_tier_code),
  foreign key(business_id,service_id) references services(business_id,id)
);

alter table appointment_services
  add column pricing_class_snapshot text,
  add column weight_tier_snapshot text,
  add column resolution_source_snapshot text;

alter table business_breeds enable row level security;
create policy tenant_isolation on business_breeds
  using (business_id=nullif(current_setting('app.business_id',true),'')::uuid)
  with check (business_id=nullif(current_setting('app.business_id',true),'')::uuid);
alter table service_price_tiers enable row level security;
create policy tenant_isolation on service_price_tiers
  using (business_id=nullif(current_setting('app.business_id',true),'')::uuid)
  with check (business_id=nullif(current_setting('app.business_id',true),'')::uuid);

insert into schema_migrations(version) values ('0012_service_pricing_and_breed_catalog');
commit;
