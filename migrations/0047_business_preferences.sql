begin;

-- ---------------------------------------------------------------------------
-- Settings -> Business: the full preference set.
--
-- COLUMNS ON `businesses`, NOT A `business_settings` TABLE. The three preferences this screen
-- already saves - `currency`, `tax_rate_basis_points`, `reminder_lead_minutes` - are columns on
-- `businesses` and have been since 0001. They are singleton scalars: exactly one value per
-- workspace, never zero, never many. A 1:1 side table for more of the same buys nothing and costs
-- four things at every call site - a join on every read that wants one, a "what if the row does
-- not exist yet" branch, a bootstrap path that has to create the row for the workspaces that
-- predate it, and its own `tenant_isolation` policy. `select b.*` on `/api/me` is how this screen
-- is already fed, and `postgres.camel` turns each column below into its camelCase field with no
-- route change; a side table would make every one of those a deliberate act.
--
-- The split with `locations` is respected and not eroded. `timezone` and `address` live there
-- because a workspace may have several locations and each has its own; nothing added here is
-- per-location. A second salon does not keep its own date format.
--
-- `businesses` carries no `tenant_isolation` policy and none is added: it is the tenant ROOT,
-- keyed by `id` rather than `business_id`, so the policy's predicate has nothing to bind to. That
-- is the same posture `currency` has had since 0001, and these columns inherit it exactly.
--
-- DEFAULTS ARE CHOSEN TO BE TRUE OF EVERY EXISTING WORKSPACE, not to be aspirational. Every
-- not-null column below is added with a default, because the alternative on a populated table is
-- a failed deploy. Each default is the behaviour those workspaces already have:
--
--   date_format 'MM/DD/YYYY' and hour_format '12' - the server's four existing human-readable
--     date sites all formatted with the `en-US` locale, which is exactly month/day/year and a
--     12-hour clock. A workspace that upgrades reads the same text tomorrow as today.
--   weight_unit 'lb' - `weightTiers` labels, `poundsFromOunces`, the pet forms and the pricing
--     matrix headers are all pounds today.
--   appointment_lock 'disabled' - NOTHING ENFORCES THIS COLUMN. It is stored and returned and no
--     code path consults it, by instruction, until the semantics are decided. 'disabled' is
--     therefore the only honest default: shipping every workspace as 'enabled' would assert a
--     protection that does not exist.
--   coupon_stacking 'single' - Pawsh has no coupon domain at all. One-per-appointment is the
--     conservative reading, and this column has no consumer until coupons exist.
--   business_type 'salon' - the one default here that is a genuine guess, because the column is
--     REQUIRED on the form and existing rows must hold something. 'salon' is chosen over 'mobile'
--     because the product is already salon-shaped: `locations` with fixed addresses and per-
--     location opening hours, a "the salon is closed on ..." refusal in scheduling. A mobile
--     groomer who upgrades sees 'salon' preselected and can correct it; the reverse guess would
--     silently mark every existing salon mobile.
--
-- `upcoming_appointment_count` IS NULLABLE AND NULL MEANS "All". That is not a stand-in for
-- "unset": "All" is both the product default and the value a workspace that has never opened this
-- screen behaves as, so the two coincide honestly rather than needing a sentinel integer. The
-- bound is 1-20 when a number is given, matching the range the picker offers.
--
-- `default_service_frequency_weeks` deliberately takes the SAME type, nullability and 1-104 bound
-- as `customers.booking_frequency_weeks` in 0019, because that is the column it is the default
-- for. A business-level default whose range disagreed with the per-customer column it seeds would
-- be a setting that can be saved and then rejected on use.
--
-- The four URL-ish columns - `website` and the three social links - are bounded exactly like
-- `locations.address` in 0046 and `customer_addresses.address` in 0025: `btrim` length between 1
-- and 500, so '' and '   ' cannot become a third way of saying "not recorded". Null is the one
-- way. They are NOT validated as URLs here; that belongs in the schema layer, which can refuse a
-- request rather than failing a deploy, and which is where `businessSettingsSchema` does it.
-- ---------------------------------------------------------------------------

alter table businesses
  add column website text,
  add column business_type text not null default 'salon',
  add column date_format text not null default 'MM/DD/YYYY',
  add column hour_format text not null default '12',
  add column weight_unit text not null default 'lb',
  add column appointment_lock text not null default 'disabled',
  add column coupon_stacking text not null default 'single',
  add column upcoming_appointment_count integer,
  add column default_service_frequency_weeks integer,
  add column social_facebook text,
  add column social_google text,
  add column social_yelp text;

-- Every enum is a check constraint rather than a Postgres enum type, matching `payment_methods
-- .settlement_type` in 0034 and `businesses.status` in 0001. Adding a value to a check is one
-- migration; adding one to an enum type is a migration plus a `alter type ... add value` that
-- cannot run inside a transaction alongside the rest.
--
-- The string spellings are the wire values verbatim. There is no mapping layer between what the
-- API accepts and what the column stores, so a value read out of the database can be compared
-- against the tuple in `@pawsh/domain` without a translation table that could disagree with it.
alter table businesses
  add constraint business_type_supported
    check (business_type in ('mobile', 'salon', 'hybrid')),
  add constraint business_date_format_supported
    check (date_format in ('MM/DD/YYYY', 'DD/MM/YYYY')),
  add constraint business_hour_format_supported
    check (hour_format in ('12', '24')),
  add constraint business_weight_unit_supported
    check (weight_unit in ('lb', 'kg')),
  add constraint business_appointment_lock_supported
    check (appointment_lock in ('enabled', 'disabled')),
  add constraint business_coupon_stacking_supported
    check (coupon_stacking in ('single', 'amount_first', 'percentage_first')),
  add constraint business_upcoming_appointment_count_range
    check (upcoming_appointment_count is null or upcoming_appointment_count between 1 and 20),
  add constraint business_default_service_frequency_range
    check (default_service_frequency_weeks is null
      or default_service_frequency_weeks between 1 and 104),
  add constraint business_website_bounded
    check (website is null or char_length(btrim(website)) between 1 and 500),
  add constraint business_social_facebook_bounded
    check (social_facebook is null or char_length(btrim(social_facebook)) between 1 and 500),
  add constraint business_social_google_bounded
    check (social_google is null or char_length(btrim(social_google)) between 1 and 500),
  add constraint business_social_yelp_bounded
    check (social_yelp is null or char_length(btrim(social_yelp)) between 1 and 500);

insert into schema_migrations(version) values ('0047_business_preferences');
commit;
