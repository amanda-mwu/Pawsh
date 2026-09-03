begin;

-- ---------------------------------------------------------------------------
-- Settings -> Coupon & Discount.
--
-- Until now a bill could carry exactly one discount: `invoices.discount_minor`
-- with a free-text `invoices.discount_type` beside it, both keyed by hand at
-- checkout, neither drawn from anything a salon had configured. This adds the
-- catalog (`discounts`, `coupons`), the record of what a coupon has been spent
-- on (`coupon_redemptions`), the per-invoice breakdown that lets a receipt say
-- what came off and why (`invoice_discounts`), and the one business-level rule
-- that decides whether more than one may come off at all.
--
-- WHY THE STACKING MODE DEFAULTS TO `one_per_appointment`. That value is not a
-- conservative guess, it is the truthful description of what checkout does
-- today: one `discount_minor` column is one discount, so a business row landing
-- on anything else would be this migration quietly widening what checkout
-- permits for every existing salon. The default changes nothing; an owner opts
-- into stacking.
--
-- WHY DISCOUNTS AND COUPONS ARE TWO TABLES AND NOT ONE WITH A FLAG. They differ
-- in who initiates them and in what that costs. A discount is OPERATOR-GRANTED:
-- somebody with `discounts.apply` decides this customer gets 10% off, and the
-- permission is the whole control. A coupon is CUSTOMER-PRESENTED: the customer
-- earned it elsewhere, the operator is keying in a code that was already issued,
-- and refusing it needs a reason - which is why only coupons carry limitations
-- (a date range, a weekday, new clients, redemption caps) and only coupons are
-- consumed. Folding them together would put five nullable limitation columns on
-- the operator's table that nothing would ever read.
--
-- NULLABLE MEANS UNSET, on every coupon limitation, exactly as 0023 established
-- for partial client records. `ends_on is null` is "no end date", not a date
-- stood in for; `max_redemptions is null` is "unlimited", not a very large
-- number. There is one deliberate exception and it is named at the column.
--
-- WHAT IS NOT HERE:
--
--   * No `redeemed_count` on `coupons`. A stored counter is a second source of
--     truth for a number `count(*)` over `coupon_redemptions` already answers,
--     and it would need the same row lock the cap check takes anyway - so it
--     would buy nothing and could drift.
--
--   * No hard delete. `discounts.active` and `coupons.active` are how a row
--     retires, because `invoice_discounts` and `coupon_redemptions` reference
--     them from historical invoices. This is the same thing
--     `DELETE /api/services/:id` has always meant. `tax_rates` hard-deletes
--     only because an invoice snapshots the rate and keeps no pointer back.
--
--   * NO WAY TO GIVE A REDEMPTION BACK. Pawsh has no route that voids an
--     invoice - `status = 'void'` is read in seven places and written in none -
--     so a coupon consumed at checkout is consumed permanently, even if the
--     visit is later disputed. That is a KNOWN LIMITATION recorded here rather
--     than a void flow invented alongside a settings screen. When invoice
--     voiding lands it will have to decide what happens to the redemption, and
--     `coupon_redemptions.invoice_id` is the join that will let it.
-- ---------------------------------------------------------------------------

-- The stacking rule sits on `businesses` beside `currency` and
-- `tax_rate_basis_points`, which is where money-shaped configuration already
-- lives in this schema, and NOT on `locations`: checkout already joins
-- `businesses` for the tax rate, so reading it costs no extra query.
alter table businesses
  add column discount_stacking_mode text not null default 'one_per_appointment'
    check (discount_stacking_mode in ('one_per_appointment', 'amount_first', 'percentage_first'));

-- ---------------------------------------------------------------------------
-- The operator's catalog.
-- ---------------------------------------------------------------------------

create table discounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('amount', 'percentage')),
  -- Integer minor units and basis points, matching `invoices.discount_minor` and
  -- `businesses.tax_rate_basis_points`. Exactly one is set, and which one is
  -- decided by `kind`; see `discount_value_matches_kind`.
  amount_minor integer check (amount_minor >= 0),
  rate_basis_points integer check (rate_basis_points between 0 and 10000),
  -- Whether a FIXED AMOUNT comes off once per visit or once per pet. It is
  -- recorded and not yet multiplied: `appointments.pet_id` is a single non-null
  -- column and one appointment produces one invoice, so the pet count at
  -- checkout is always 1 and the two scopes currently produce identical money.
  --
  -- FOR A PERCENTAGE IT IS ARITHMETICALLY MEANINGLESS - 10% of a bill is 10% of
  -- that bill however many pets it covers - and there is deliberately NO CHECK
  -- forbidding the combination. An operator who picks per-pet on a percentage
  -- has said something harmless; a constraint refusing it would exist only to
  -- police a form, and would have to be dropped the day the form changed.
  apply_scope text not null default 'per_appointment'
    check (apply_scope in ('per_appointment', 'per_pet')),
  active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  constraint discount_value_matches_kind check (
    (kind = 'amount' and amount_minor is not null and rate_basis_points is null)
    or (kind = 'percentage' and rate_basis_points is not null and amount_minor is null)
  )
);

-- PARTIAL ON `active`, unlike the coupon code index below. A retired discount is
-- a label on old receipts and nothing more, so its name is free to be reused;
-- reserving "Senior discount" forever because somebody once retired one would be
-- a rule an owner cannot see and cannot clear.
create unique index discount_name_per_business on discounts (business_id, lower(btrim(name)))
  where active;

-- ---------------------------------------------------------------------------
-- The customer's codes.
-- ---------------------------------------------------------------------------

create table coupons (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  code text not null check (char_length(btrim(code)) between 1 and 40),
  -- What the salon calls it internally. Optional: the code is the identity, and
  -- a salon that types SPRING25 and nothing else has not left a field blank, it
  -- has said the code is the whole name.
  name text check (name is null or char_length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('amount', 'percentage')),
  amount_minor integer check (amount_minor >= 0),
  rate_basis_points integer check (rate_basis_points between 0 and 10000),
  apply_scope text not null default 'per_appointment'
    check (apply_scope in ('per_appointment', 'per_pet')),

  -- --- Limitations. Every one of these is NULL-MEANS-UNSET. -----------------
  -- Evaluated against the APPOINTMENT'S LOCAL DATE in its snapshotted
  -- `scheduling_timezone`, never against checkout time and never against the
  -- location's current timezone. A Tuesday groom checked out on Wednesday
  -- morning is a Tuesday groom, and a salon that moved timezone last year did
  -- not retroactively move the visits it had already booked. `date` rather than
  -- `timestamptz` because that is what the comparison is: two civil dates.
  starts_on date,
  ends_on date,
  -- Days of the week the coupon is good for, 0 = Sunday, matching the weekday
  -- convention `working_hours` already uses. NULL is any day. An EMPTY array is
  -- refused rather than treated as "any": it is a coupon that could never be
  -- redeemed, which is a mistake and not a setting.
  --
  -- Duplicates inside the array are harmless to the membership test the checkout
  -- makes, and a CHECK cannot express distinctness without a subquery, so the
  -- API sorts and deduplicates on the way in rather than the schema pretending
  -- to enforce it.
  weekdays smallint[],
  -- The one limitation stored as a two-valued NOT NULL rather than as nullable.
  -- `false` here is not a placeholder standing in for an unknown - the way
  -- 0023's 'Not Set' would have been - it is the honest, complete statement
  -- "this coupon is not restricted to new clients". A third state would be a
  -- distinction with no meaning that every read would have to handle.
  new_clients_only boolean not null default false,
  -- How many times in total, and how many times by any one client. NULL is
  -- unlimited. Both are counted inside the checkout transaction against
  -- `coupon_redemptions` under a row lock on this coupon, so a cap is a cap
  -- under concurrency and not a suggestion.
  max_redemptions integer check (max_redemptions >= 1),
  max_redemptions_per_client integer check (max_redemptions_per_client >= 1),
  -- -------------------------------------------------------------------------

  active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  constraint coupon_value_matches_kind check (
    (kind = 'amount' and amount_minor is not null and rate_basis_points is null)
    or (kind = 'percentage' and rate_basis_points is not null and amount_minor is null)
  ),
  constraint coupon_date_range_ordered check (
    starts_on is null or ends_on is null or starts_on <= ends_on
  ),
  constraint coupon_weekdays_are_meaningful check (
    weekdays is null
    or (cardinality(weekdays) between 1 and 7
        and weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[])
  )
);

-- CASE-INSENSITIVE, BUSINESS-SCOPED, AND DELIBERATELY NOT PARTIAL ON `active`.
--
-- A customer holding a printed SPRING25 must never be handed somebody else's
-- meaning of SPRING25 because the first one was retired. A redeemed code is a
-- promise that was made in public, and `coupon_redemptions` points at the row
-- that made it, so the code stays claimed for the life of the business. That is
-- the exact opposite of the discount name rule above, and the difference is that
-- a discount name was only ever seen by staff.
create unique index coupon_code_per_business on coupons (business_id, upper(btrim(code)));

create table coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  coupon_id uuid not null,
  invoice_id uuid not null,
  customer_id uuid not null,
  -- What it actually took off, after compounding and clamping - not what the
  -- coupon says it is worth. A 20% coupon on an already-discounted bill is
  -- worth less than 20% of the subtotal, and this is the number that happened.
  amount_minor integer not null check (amount_minor >= 0),
  redeemed_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  -- THE STRUCTURAL BACKSTOP. The checkout takes `select ... for update` on the
  -- coupon row before counting, so two concurrent checkouts against a coupon
  -- with one redemption left serialize and exactly one wins. This is what holds
  -- if that lock is ever lost: one invoice can consume one coupon once.
  unique (business_id, coupon_id, invoice_id),
  foreign key (business_id, coupon_id) references coupons (business_id, id),
  foreign key (business_id, invoice_id) references invoices (business_id, id),
  foreign key (business_id, customer_id) references customers (business_id, id)
);

-- The per-client cap count. The total count is already served by the leading
-- columns of the unique constraint above, so it needs no index of its own.
create index coupon_redemption_by_client
  on coupon_redemptions (business_id, coupon_id, customer_id);

-- ---------------------------------------------------------------------------
-- What came off this bill, and why.
--
-- The receipt discount metadata the roadmap already required. Everything is a
-- SNAPSHOT, for the same reason `invoice_items` snapshots a service name and a
-- price: a receipt has to keep saying what the customer was told, and the
-- catalog row it came from can be edited or retired afterwards.
--
-- `applied_minor` is what the line actually took off after compounding and
-- clamping; the `*_snapshot` columns are what the row said at the time. The two
-- are different numbers - "20% off" and "$14.40" - and a receipt needs both.
--
-- THE TOTAL INVARIANT: for every invoice, sum(applied_minor) = discount_minor.
-- The backfill below is what makes it total rather than "total since 0046",
-- which is why it copies `discount_type` VERBATIM INCLUDING ITS NULLS instead
-- of inventing a name for the rows that never had one.
-- ---------------------------------------------------------------------------

create table invoice_discounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  invoice_id uuid not null,
  -- The order it was applied in, which is what makes the compounding legible on
  -- a receipt. Named to match `invoice_items.line_position` rather than
  -- `position`, which is a PostgreSQL function name.
  line_position integer not null check (line_position >= 1),
  source text not null check (source in ('manual', 'discount', 'coupon')),
  discount_id uuid,
  coupon_id uuid,
  -- NULLABLE, AND THAT IS LOAD-BEARING. A historical manual discount often had
  -- no `discount_type` at all, and the client has always rendered a plain
  -- "Discount" for those. Copying the null through keeps that display exactly as
  -- it is instead of writing a name nobody ever chose.
  name_snapshot text,
  kind_snapshot text not null check (kind_snapshot in ('amount', 'percentage')),
  amount_minor_snapshot integer check (amount_minor_snapshot >= 0),
  rate_basis_points_snapshot integer check (rate_basis_points_snapshot between 0 and 10000),
  apply_scope_snapshot text
    check (apply_scope_snapshot is null or apply_scope_snapshot in ('per_appointment', 'per_pet')),
  -- The per-pet multiplier that was actually used. Always 1 today.
  units_snapshot integer not null default 1 check (units_snapshot >= 1),
  applied_minor integer not null check (applied_minor >= 0),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, invoice_id, line_position),
  foreign key (business_id, invoice_id) references invoices (business_id, id),
  -- MATCH SIMPLE, so a null `discount_id` satisfies the constraint. Which of the
  -- two is set is decided by `source`, below.
  foreign key (business_id, discount_id) references discounts (business_id, id),
  foreign key (business_id, coupon_id) references coupons (business_id, id),
  constraint invoice_discount_source_reference check (
    (source = 'manual' and discount_id is null and coupon_id is null)
    or (source = 'discount' and discount_id is not null and coupon_id is null)
    or (source = 'coupon' and coupon_id is not null and discount_id is null)
  ),
  constraint invoice_discount_value_matches_kind check (
    (kind_snapshot = 'amount' and amount_minor_snapshot is not null)
    or (kind_snapshot = 'percentage' and rate_basis_points_snapshot is not null)
  )
);

create index invoice_discount_by_invoice on invoice_discounts (business_id, invoice_id, line_position);

-- ---------------------------------------------------------------------------
-- Backfill: one row per existing invoice that carried a discount.
--
-- Every historical discount was keyed by hand as an amount in minor units, so
-- `source = 'manual'`, `kind_snapshot = 'amount'` and
-- `amount_minor_snapshot = applied_minor = discount_minor` are all statements of
-- what actually happened, not reconstructions. `discount_type` goes into
-- `name_snapshot` unchanged, nulls and all.
--
-- No status filter: a void invoice's breakdown still has to sum to its
-- `discount_minor`, and the invariant is only worth having if it has no
-- exceptions. `created_at` is copied from the invoice so the row does not claim
-- to have been written today.
-- ---------------------------------------------------------------------------

insert into invoice_discounts
  (business_id, invoice_id, line_position, source, name_snapshot, kind_snapshot,
   amount_minor_snapshot, units_snapshot, applied_minor, created_at)
select business_id, id, 1, 'manual', discount_type, 'amount',
  discount_minor, 1, discount_minor, created_at
from invoices
where discount_minor > 0;

-- The backfill is the whole basis of the total invariant, so it is verified here
-- rather than trusted. If any invoice's breakdown fails to sum to its
-- `discount_minor`, this migration refuses to commit.
do $$
declare mismatched integer;
begin
  select count(*) into mismatched
  from invoices i
  where i.discount_minor <> coalesce(
    (select sum(d.applied_minor) from invoice_discounts d
     where d.business_id = i.business_id and d.invoice_id = i.id), 0);
  if mismatched > 0 then
    raise exception 'invoice discount backfill left % invoice(s) whose breakdown does not sum to discount_minor', mismatched;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level tenant isolation, DECLARED HERE rather than in a follow-up.
--
-- 0034 created five tables without it and 0035 existed solely to repair that.
-- The bulk loop in 0001 ran once and cannot cover a table that did not exist
-- yet, so every migration that creates one restates it. Note that these policies
-- do not enforce anything while Pawsh connects as the table owner with no FORCE
-- ROW LEVEL SECURITY (see 0033) - the composite foreign keys above are the
-- defence that actually holds. This is the layer underneath, for anything that
-- reaches these tables without going through a route.
-- ---------------------------------------------------------------------------

do $$
declare
  target text;
begin
  foreach target in array array[
    'discounts', 'coupons', 'coupon_redemptions', 'invoice_discounts'
  ] loop
    execute format('alter table %I enable row level security', target);
    execute format(
      'create policy tenant_isolation on %I using (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid) with check (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)',
      target
    );
  end loop;
end $$;

insert into schema_migrations(version) values ('0046_discounts_and_coupons');
commit;
