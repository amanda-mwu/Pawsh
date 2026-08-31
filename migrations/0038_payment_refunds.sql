begin;

-- ---------------------------------------------------------------------------
-- Giving money back, as rows that can only ever say true things.
--
-- THERE IS NO NEGATIVE PAYMENT, AND THERE MUST NOT BE. `payments.amount_minor` is
-- `check (amount_minor > 0)`, so a refund cannot be a payment row even if somebody wanted it to
-- be; and widening `payment_status` past 'recorded' / 'voided' would be worse than the check
-- constraint, because the void route settles an invoice with
-- `sum(amount_minor) where status='recorded'` and every report in this schema does the same
-- arithmetic. A third status would silently join or silently leave that sum depending on which
-- query somebody wrote, and the two answers would both look right. So a refund is its own row in
-- its own table, `amount_minor > 0` like every other money column here, and the original payment
-- is never mutated, never deleted and never reinterpreted. The payment says what was taken. The
-- refund says what went back. Neither has to be read through the other.
--
-- THE SUM CEILING IS NOT A CONSTRAINT, BECAUSE IT CANNOT BE. "The refunds against a payment may
-- not exceed it" is a statement about a set of rows, and a check constraint sees one row. So it
-- is enforced where every other cross-row financial rule in this schema is enforced: inside the
-- transaction, under `select ... from payments where id=... for update`, which is the same lock
-- the void route already takes. `pending` refunds count against the remaining headroom - they
-- have not moved money yet, but a retry that ignored them could ask Square for the same money
-- twice - and a `failed` refund releases it again.
--
-- A PENDING REFUND MAY NAME A PROVIDER BEFORE IT HAS A PROVIDER REFERENCE, AND THAT IS THE
-- POINT. `payments` refuses the half-filled shape outright, because a payment is only ever
-- inserted after its Square Payment has been retrieved: there is no moment at which a payment row
-- legitimately knows the provider and not the id. A refund is the other way round. The row is
-- claimed BEFORE Square is called, exactly as `square_terminal_checkouts` is, because that is
-- what makes the idempotency key derivable from disk after a lost response - and a row claimed
-- before the call cannot possibly carry the id the call is about to return. So the identity rule
-- is stated for the state it actually applies to: a `completed` provider refund must carry its
-- reference, a reference may never appear without a provider, and the only rows allowed to name a
-- provider without a reference are the ones that have not been given one yet (`pending`) or never
-- will be (`failed`). The unique index below is what stops two rows claiming the same Square
-- refund, and every row it has to police is one that has a reference.
--
-- ATTEMPT NUMBERS ARE WHAT MAKE THE KEY RE-DERIVABLE, exactly as they are on a checkout. The key
-- is sha256 over the business, the payment, the amount and this counter; storing the counter is
-- what lets a test recompute the key from the row rather than trust that it was computed
-- correctly once. `unique (business_id, payment_id, attempt)` stops two concurrent refunds of one
-- payment both believing they are attempt two, which is the one way two different requests could
-- derive the same key.
--
-- THE TIP IS A COLUMN BECAUSE THE SPLIT IS OURS, NOT SQUARE'S. `POST /v2/refunds` takes one
-- `amount_money` and gives back one `amount_money`; it neither knows nor reports how much of that
-- was gratuity. Pawsh decides - the service amount absorbs a refund first and the tip is touched
-- only once the service portion is exhausted - so the decision has to be written down rather than
-- recomputed later by whichever screen happens to need it. A groomer's earned gratuity is not
-- clawed back proportionally for a service complaint that was not theirs, and the customer still
-- gets every cent of the disputed service back before the tip is reached.
-- ---------------------------------------------------------------------------

create table payment_refunds (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  -- Both composite, both tenant-qualified. `payments_business_scoped_key` was added by 0036 for
  -- exactly this reason: without it nothing could reference a payment by tenant-qualified key,
  -- and a refund that could point at another business's payment is a cross-tenant write no
  -- amount of application checking makes safe.
  payment_id uuid not null,
  invoice_id uuid not null,
  amount_minor integer not null check (amount_minor > 0),
  -- How much of `amount_minor` came out of the tip. Zero until the service portion is exhausted.
  tip_refunded_minor integer not null default 0 check (tip_refunded_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider text check (provider in ('square')),
  provider_refund_id text,
  -- Square's Refunds API idempotency key is at most 45 characters. Terminal's is 64; the two
  -- limits are different and the generators are deliberately not shared.
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 45),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  -- The operator's own words, passed to Square as `reason` and shown back on the invoice.
  reason text check (reason is null or char_length(btrim(reason)) between 1 and 192),
  requested_by uuid not null references users(id),
  attempt integer not null default 1 check (attempt > 0),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  -- Why a refund failed, in a sentence. Also carries the last transient refusal on a row that is
  -- still pending, so an operator can see why nothing has happened yet; a completed refund has
  -- no failure to report and must not be able to claim one.
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 500),
  unique (business_id, id),
  unique (business_id, payment_id, attempt),
  foreign key (business_id, payment_id) references payments(business_id, id),
  foreign key (business_id, invoice_id) references invoices(business_id, id),
  constraint payment_refund_provider_identity check (
    (provider is null and provider_refund_id is null)
    or (provider is not null and provider_refund_id is not null)
    or (provider is not null and provider_refund_id is null and status in ('pending', 'failed'))
  ),
  -- The tip cannot be more of the refund than the refund is.
  constraint payment_refund_tip_within_amount check (tip_refunded_minor <= amount_minor),
  -- Settled exactly when completed. `settled_at` is the moment the money went back, which is not
  -- the moment the row was written and not the moment it was last polled.
  constraint payment_refund_settlement_time check (
    (status = 'completed') = (settled_at is not null)
  ),
  constraint payment_refund_failure_reason check (
    (status = 'failed' and failure_reason is not null)
    or (status = 'completed' and failure_reason is null)
    or status = 'pending'
  )
);

-- Two rows claiming the same Square refund are two rows counting the same money twice. This is
-- the structural guarantee, in the database, under concurrency, exactly as
-- `payment_provider_reference` is for payments.
create unique index payment_refund_provider_reference
  on payment_refunds (business_id, provider, provider_refund_id) where provider is not null;
-- A key is one request. Re-deriving it must find the row that already holds it rather than mint a
-- second refund that happens to look the same.
create unique index payment_refund_idempotency_per_business
  on payment_refunds (business_id, idempotency_key);
-- The headroom read: every refund against one payment, in the order they were asked for.
create index payment_refund_payment on payment_refunds (business_id, payment_id, created_at);
create index payment_refund_invoice on payment_refunds (business_id, invoice_id, created_at);
-- What is still in flight, which is what a screen and the drain both ask for.
create index payment_refund_open on payment_refunds (business_id, created_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- `invoice_status` gains two values, and neither of them is a kind of paid.
--
-- The alternative was to leave a refunded invoice at `paid` and derive the refund from sums. That
-- is rejected: an invoice whose money went back is not a paid invoice, and every read path that
-- says "Paid" for returned money is telling the operator something false at exactly the moment
-- they are trying to work out what happened.
--
-- The invoice's MONEY does not move, and that is a separate decision from its status.
-- `total_minor` is what was billed and still is. `tip_minor` must not move because reconciliation
-- raises it exactly once behind a `where tip_minor = 0` fence, and a refund that lowered it would
-- unlatch that fence and let a second tip raise land on the same invoice. `balance_minor` must
-- not move because raising it would assert the customer owes money they do not owe, and would put
-- the invoice back in front of whoever chases outstanding balances.
--
-- BOTH EXISTING PARTIAL INDEXES ON `invoices` STAY CORRECT UNDER THE NEW VALUES, which was
-- checked rather than assumed:
--   `one_active_invoice_per_appointment ... where status <> 'void'` - a refunded invoice is not
--   void, so it stays in the index and still blocks a second invoice being raised for the same
--   appointment. That is what should happen: the visit was invoiced, and refunding it does not
--   make the appointment un-invoiced.
--   `invoice_outstanding ... where status in ('open','partially_paid')` - the new values are not
--   in the predicate, so a refunded invoice does not appear in the outstanding list. That is also
--   what should happen: its balance is zero and nothing is owed. An invoice that still owes money
--   never reaches these statuses at all; the refunded statuses replace `paid` and only `paid`,
--   so an invoice with a live balance stays `open` or `partially_paid` and stays collectable.
-- ---------------------------------------------------------------------------

alter type invoice_status add value if not exists 'partially_refunded';
alter type invoice_status add value if not exists 'refunded';

-- ---------------------------------------------------------------------------
-- Refunding is a financial operation, so it is replay-protected like every other one.
--
-- The Square idempotency key on the row protects against OUR request to Square being repeated.
-- This protects against the CLIENT's request to us being repeated - a double-tapped button, a
-- retried fetch - which is a different failure with the same consequence, and the one the
-- `Idempotency-Key` header has covered since 0006.
-- ---------------------------------------------------------------------------

alter table financial_idempotency_requests
  drop constraint financial_idempotency_requests_operation_check;
alter table financial_idempotency_requests
  add constraint financial_idempotency_requests_operation_check
  check (operation in (
    'checkout.create-invoice', 'payment.record', 'payment.void', 'payment.refund'
  ));

alter table payment_refunds enable row level security;
create policy tenant_isolation on payment_refunds
using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

insert into schema_migrations(version) values ('0038_payment_refunds');
commit;
