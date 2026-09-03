begin;

-- ---------------------------------------------------------------------------
-- Client credit: money the salon already owes this customer, spendable at the
-- till.
--
-- CREDIT IS A PAYMENT, NOT A DISCOUNT, and that is the whole reason this table
-- exists instead of a fifth `source` on `invoice_discounts`. `calculateInvoice`
-- taxes `subtotal - discount`, so routing credit through the discount path
-- would shrink the taxable base by the amount redeemed and under-collect tax on
-- every single redemption, permanently, on real money. A discount changes what
-- is owed. Credit changes what has been settled. They land on opposite sides of
-- the tax line and nothing about them is interchangeable.
--
-- THE BALANCE IS A SUM, AND THERE IS NO `customers.credit_minor`. A stored
-- balance is a second source of truth for a number `sum(amount_minor)` already
-- answers, and it would need the same row lock the redemption check takes
-- anyway - so it would buy nothing and could drift. This is the identical
-- refusal 0048 made for `coupons.redeemed_count`.
--
-- `amount_minor` IS SIGNED, WHICH DIVERGES FROM EVERY OTHER MONEY COLUMN IN
-- THIS SCHEMA, and the divergence is the point rather than an oversight. The
-- property being bought is that `sum(amount_minor)` IS the balance - one
-- aggregate, one column, no interpretation. Split into two non-negative columns
-- (`granted_minor`, `used_minor`) the balance becomes a subtraction of two sums
-- that NO constraint can relate to each other, and any query that forgot one
-- side would return a plausible wrong number. A `check (amount_minor <> 0)`
-- keeps the one value that would be a row saying nothing out of the table, and
-- `credit_entry_sign_matches_kind` below ties the sign to the kind so the
-- signed column cannot be used to write a nonsense entry.
--
-- NO EXPIRY. Nothing here dates, ages, or sweeps a balance. Expiring credit is
-- taking money back from a customer on a timer, which is a product decision
-- nobody has made, and a nullable `expires_at` that nothing reads would be an
-- invitation to make it accidentally.
--
-- WHAT IS NOT HERE:
--
--   * NO GIFT CARDS. They are a deliberate non-goal, not an oversight. A gift
--     card is credit that is bought rather than granted, so it needs its own
--     invoice - and `invoices.appointment_id` is `not null` today, relied on by
--     `one_active_invoice_per_appointment` and by every report that joins
--     invoices to appointments. Making it nullable is a change to the core
--     financial model and it is not made here.
--
--   * NO DELETE AND NO UPDATE. The trigger below refuses both, following
--     `pet_document_scan_attempts_immutable` in 0009 verbatim. A mistaken entry
--     is corrected by a COMPENSATING entry that names the row it corrects, so
--     the ledger keeps saying what actually happened and the correction is
--     itself auditable. An edited ledger is not a ledger.
--
--   * NO OVERDRAFT CONSTRAINT, AND NO INDEX THAT SUBSTITUTES FOR ONE. See the
--     honest statement at the two partial indexes below.
-- ---------------------------------------------------------------------------

create table customer_credit_entries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  customer_id uuid not null,

  -- The four things that can happen to a balance, and nothing else.
  --
  --   grant               staff hand the customer credit. Always positive.
  --   adjustment          staff correct a balance. EITHER SIGN, which is why it
  --                       is a separate kind from `grant` rather than a grant
  --                       that happens to be negative: "we gave them $20" and
  --                       "we took $20 back" are different sentences on a
  --                       screen and different events in a dispute.
  --   redemption          the customer spent it at checkout. Always negative,
  --                       always paired with the `payments` row it settled.
  --   redemption_reversal that payment was voided and the money came back.
  --                       Always positive, always paired with the same payment.
  kind text not null
    check (kind in ('grant', 'adjustment', 'redemption', 'redemption_reversal')),
  amount_minor integer not null check (amount_minor <> 0),

  -- Set by `kind`, under `credit_entry_source_reference` below. Both nullable
  -- because a grant has neither, in the shape 0048 used for
  -- `invoice_discount_source_reference`.
  invoice_id uuid,
  payment_id uuid,

  -- REQUIRED FOR BOTH `grant` AND `adjustment`, and required for a deduction is
  -- the half that matters. A negative adjustment takes money off a customer's
  -- balance; it is MORE contestable than a grant, not less, and this is the row
  -- a dispute lands on. Optional on the two machine-written kinds: a redemption
  -- explains itself through the invoice it settled, and a reversal carries the
  -- operator's void reason so the ledger line reads without a join.
  reason text check (reason is null or char_length(btrim(reason)) <= 500),

  -- The compensating-entry link. An adjustment may name the entry it corrects,
  -- which is what makes "we granted $50 by mistake, here is the -$50" a PAIR on
  -- screen rather than two unrelated rows a reader has to guess about. Nullable
  -- because most adjustments correct a balance rather than a specific row.
  corrects_entry_id uuid,

  created_by uuid references users(id),
  created_at timestamptz not null default now(),

  unique (business_id, id),
  foreign key (business_id, customer_id) references customers (business_id, id),
  -- MATCH SIMPLE, so a null reference satisfies the constraint. Composite and
  -- tenant-qualified for the same reason 0038's refund references are: an entry
  -- that could point at another business's payment is a cross-tenant write no
  -- amount of application checking makes safe.
  foreign key (business_id, invoice_id) references invoices (business_id, id),
  foreign key (business_id, payment_id) references payments (business_id, id),
  foreign key (business_id, corrects_entry_id)
    references customer_credit_entries (business_id, id),

  -- The sign is not free. Written in the shape of 0048's
  -- `discount_value_matches_kind`: the kind decides which values are
  -- representable, so a redemption that adds to a balance cannot be inserted at
  -- all. `adjustment` is the one kind that admits both signs, which is exactly
  -- what it is for.
  constraint credit_entry_sign_matches_kind check (
    (kind = 'grant' and amount_minor > 0)
    or (kind = 'adjustment' and amount_minor <> 0)
    or (kind = 'redemption' and amount_minor < 0)
    or (kind = 'redemption_reversal' and amount_minor > 0)
  ),

  -- Which reference is set is decided by `kind`, exactly as
  -- `invoice_discount_source_reference` decides between `discount_id` and
  -- `coupon_id`. A redemption and its reversal both name the payment AND the
  -- invoice: the payment is the identity of the event, the invoice is what the
  -- ledger line has to say to be readable.
  constraint credit_entry_source_reference check (
    (kind in ('grant', 'adjustment') and invoice_id is null and payment_id is null)
    or (kind in ('redemption', 'redemption_reversal')
        and invoice_id is not null and payment_id is not null)
  ),

  constraint credit_entry_reason_required check (
    (kind in ('grant', 'adjustment')
      and char_length(btrim(coalesce(reason, ''))) between 1 and 500)
    or kind in ('redemption', 'redemption_reversal')
  ),

  -- Only an adjustment corrects something. A grant is not a correction, and a
  -- machine-written redemption is corrected by voiding its payment, not by
  -- pointing at it.
  constraint credit_entry_correction_is_an_adjustment check (
    corrects_entry_id is null or kind = 'adjustment'
  ),
  constraint credit_entry_does_not_correct_itself check (
    corrects_entry_id is null or corrects_entry_id <> id
  )
);

-- ---------------------------------------------------------------------------
-- The two structural backstops, AND AN HONEST STATEMENT OF WHAT THEY DO NOT DO.
--
-- Each says: one `payments` row produces at most one redemption and at most one
-- reversal. That is what stops a retried void from crediting the balance twice
-- and a re-entered redemption from debiting it twice, and it holds in the
-- database, under concurrency, whatever the route believes.
--
-- KEYED ON `payment_id`, NOT ON `invoice_id`. One credit redemption per INVOICE
-- was the obvious-looking rule and it is wrong: an operator who applies $50 of
-- credit, voids it because the customer wanted $20, and re-applies $20 would be
-- refused by the database with no way forward, because the void does not remove
-- the first redemption row. Cash may settle one invoice in several payments and
-- there is no reason credit may not. The payment is the event; the payment is
-- the key.
--
-- NEITHER INDEX PREVENTS OVERDRAFT, AND NO INDEX CAN. "The redemptions against
-- a customer may not exceed what they were granted" is a statement about an
-- AGGREGATE over a set of rows, and a unique index sees a tuple. 0048 could
-- write "this is what holds if that lock is ever lost" under its coupon index
-- because one-coupon-one-invoice really is a tuple-shaped rule. THAT SENTENCE
-- CANNOT BE WRITTEN TRUTHFULLY HERE. Overdraft is prevented by
-- `select ... from customers ... for update` in the payment transaction and by
-- nothing else. If that lock is ever lost, two concurrent redemptions can both
-- read the same pre-spend balance and both succeed, and these indexes will not
-- notice - they are about double-COUNTING one payment, not about spending money
-- twice. The lock is the guarantee. It is tested under real concurrency
-- (`tests/database/client-credit.test.ts`) precisely because there is no
-- structural net beneath it.
-- ---------------------------------------------------------------------------

create unique index customer_credit_redemption_per_payment
  on customer_credit_entries (business_id, payment_id) where kind = 'redemption';
create unique index customer_credit_reversal_per_payment
  on customer_credit_entries (business_id, payment_id) where kind = 'redemption_reversal';

-- The balance read and the newest-first ledger page are the same index: the sum
-- scans a customer's entries and the dialog pages them in reverse insertion
-- order. `id` breaks the tie so two entries written in the same transaction
-- have a stable order rather than one the planner picks.
create index customer_credit_entry_ledger
  on customer_credit_entries (business_id, customer_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Immutable, following `pet_document_scan_attempts_immutable` in 0009.
--
-- Update and delete are both refused for the same reason: an append-only ledger
-- whose rows can be edited is a table with extra steps. The balance is the sum
-- of what happened, so anything that could rewrite a row could rewrite the
-- balance without leaving a trace of having done so. A mistake is corrected by
-- a compensating entry, which is why `corrects_entry_id` exists.
-- ---------------------------------------------------------------------------

create function customer_credit_entries_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'customer credit entries are immutable';
end $$;
create trigger customer_credit_entry_immutable
  before update or delete on customer_credit_entries
  for each row execute function customer_credit_entries_immutable();

-- ---------------------------------------------------------------------------
-- Spending credit is a settlement type of its own, and deliberately NOT `other`.
--
-- `other` means money collected outside Pawsh in a form Pawsh does not name - a
-- bank transfer, a favour, a barter. Credit is the opposite: it is money PAWSH
-- ITSELF is tracking, in a ledger Pawsh owns, and it needs three things `other`
-- cannot give it. It needs its own row in the payment-method report, because a
-- salon that cannot separate "collected $400 cash" from "honoured $400 of credit
-- we already owed" cannot reconcile a till. It needs its own reversal rule,
-- because voiding it must return money to a balance rather than to nothing. And
-- it needs to be refused by the Square refund path, which it is for free:
-- `refundPayment` requires `payment.provider`, and a credit payment has none.
--
-- `paymentMethodLabels` in `packages/domain/src/enums.ts` is a total `Record`
-- over this tuple, so the TypeScript build fails if this value is added without
-- a label. The drop-and-add is 0038's pattern for widening a named check.
--
-- THE CONSEQUENCE, STATED RATHER THAN DISCOVERED LATER: `applyInvoiceSettlement`
-- sums `payments where status='recorded'` without filtering on method, so a
-- credit payment settles an invoice exactly as cash does, and the reporting
-- endpoint's `paidRevenueMinor` therefore includes money that was not collected
-- in that period. That is correct and it is not a hole: the report already
-- groups by `p.method`, so `client_credit` becomes its own row for free, and the
-- documented invariant
-- `sum(paymentMethods[].amountMinor) = totals.paidRevenueMinor` still holds
-- because both sides count the same recorded payments. A reader who wants cash
-- collected reads the method rows; a reader who wants "is this invoice settled"
-- reads the total. Both were already true statements and both stay true.
--
-- `payment_methods.settlement_type` (0034) IS DELIBERATELY NOT WIDENED. That
-- check governs the methods a salon CONFIGURES in Settings, and a configurable
-- "Store credit" tile would let an operator record a `client_credit` payment
-- through the ordinary method picker without ever touching the ledger - money
-- spent from a balance that never moved. Credit is reachable only through the
-- branch in `POST /api/invoices/:id/payments` that debits the ledger under the
-- customer lock. The unwidened 0034 check is the backstop for that.
-- ---------------------------------------------------------------------------

alter table payments drop constraint payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('cash', 'external_card', 'check', 'other', 'client_credit'));

-- ---------------------------------------------------------------------------
-- Granting and adjusting credit is a financial operation, so it is
-- replay-protected like every other one.
--
-- EASY TO MISS AND IT FAILS AT RUNTIME, NOT AT BUILD: `claimFinancialRequest`
-- inserts the operation name as text, so an un-widened check surfaces as a 500
-- on the first grant rather than as a compile error. 0038 widened this list once
-- already for `payment.refund`.
--
-- A redemption needs no entry here: it is written inside the existing
-- `payment.record` transaction and is covered by that operation's key. A
-- reversal likewise rides on `payment.void`.
-- ---------------------------------------------------------------------------

alter table financial_idempotency_requests
  drop constraint financial_idempotency_requests_operation_check;
alter table financial_idempotency_requests
  add constraint financial_idempotency_requests_operation_check
  check (operation in (
    'checkout.create-invoice', 'payment.record', 'payment.void', 'payment.refund',
    'credit.adjust'
  ));

-- ---------------------------------------------------------------------------
-- Row-level tenant isolation, DECLARED HERE rather than in a follow-up, for the
-- reason 0048 restated: the bulk loop in 0001 ran once and cannot cover a table
-- that did not exist yet. As there, this enforces nothing while Pawsh connects
-- as the table owner without FORCE ROW LEVEL SECURITY - the composite foreign
-- keys above are the defence that actually holds.
-- ---------------------------------------------------------------------------

alter table customer_credit_entries enable row level security;
create policy tenant_isolation on customer_credit_entries
using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

insert into schema_migrations(version) values ('0050_client_credit');
commit;
