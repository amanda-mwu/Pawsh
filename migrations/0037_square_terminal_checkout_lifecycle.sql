begin;

-- ---------------------------------------------------------------------------
-- What a Terminal checkout became, and what an event that resolves to nothing is.
--
-- 0036 gave a checkout five states, which was enough to record an intent and enough to refuse
-- money that disagreed with the invoice. Taking a payment on a real terminal produces two more
-- facts that had nowhere to live, and both of them are things a person at a counter has to be
-- told honestly.
--
-- A CHECKOUT CAN FAIL WITHOUT BEING CANCELLED. `canceled` is somebody's decision - the customer
-- walked away, the groomer pressed cancel. A terminal that never woke up, an authorisation the
-- merchant revoked while the card was in the reader, a payment Square finished as FAILED: none
-- of those is a decision, and filing them as `canceled` would tell the salon somebody chose
-- this. So `failed` is added, and `cancel_reason` records Square's own word for why a
-- cancellation happened - TIMED_OUT and DEVICE_OFFLINE are the two the screen has to be able to
-- distinguish from "the customer changed their mind", because they mean try again rather than
-- take the money another way.
--
-- `completed` KEEPS ITS MEANING, AND IT IS THE STRICT ONE. A checkout is `completed` only after
-- the retrieved Square Payment has been posted to `payments` inside the reconciling transaction.
-- Square reporting COMPLETED is a wake-up, not proof, and a row that has heard it but not yet
-- reconciled stays `in_progress`. That is what makes it safe for the screen to render `completed`
-- as money taken: no other writer sets it.
--
-- ATTEMPT NUMBERS ARE WHAT MAKE THE IDEMPOTENCY KEY DERIVABLE. Square's `idempotency_key` is the
-- only thing standing between a retried request and a second charge, so it must be reproducible
-- from the facts rather than generated fresh - a random key regenerated after a network failure
-- is a second charge with extra steps. The key is a hash of the business, invoice, device,
-- amount, currency and this counter, and the counter is stored so the derivation can be checked
-- against the row afterwards rather than merely trusted. `unique (business_id, invoice_id,
-- attempt)` is what stops two concurrent starts believing they are both attempt two.
--
-- `reconciled_at` IS THE MOMENT MONEY MOVED, WHICH IS NOT `updated_at`. Every write touches
-- `updated_at`; exactly one write posts a payment, and an operator asking "when did this actually
-- settle" must not be answered with the timestamp of the last status poll.
--
-- AN EVENT THAT IS NOT OURS IS PARKED, NOT PROCESSED AND NOT FAILED. `square_merchant_id` is
-- deliberately not unique, so a Square payment id plus a merchant id cannot by itself say which
-- Pawsh business a payment belongs to - and a salon taking a payment directly on its own Square
-- account, outside Pawsh, is not a Pawsh ledger event at all. Reconciliation is therefore
-- anchored on our own `square_terminal_checkouts` row, and an event that resolves to no such row
-- must come to rest somewhere that says exactly that. `processed` would claim we acted on it;
-- `failed` would claim something went wrong and invite a retry forever. `parked` says we saw it,
-- we know whose it is not, and we are deliberately doing nothing. It carries `processed_at` so
-- the drain stops claiming it, which is why the timestamp constraint is widened to name both
-- resting states rather than only one.
-- ---------------------------------------------------------------------------

alter table square_terminal_checkouts
  -- Square's own word for a cancellation: TIMED_OUT, DEVICE_OFFLINE, CANCELED_BY_CUSTOMER and so
  -- on. Free text rather than a check constraint, because this is somebody else's vocabulary and
  -- a value we have not seen before must land in the column rather than abort the reconciler.
  add column cancel_reason text
    check (cancel_reason is null or char_length(btrim(cancel_reason)) between 1 and 64),
  -- Why a `failed` checkout failed, in a sentence a person can read. Never a stack trace and
  -- never a token: the reconciler writes a mapped reason, not the raw error.
  add column last_error text check (last_error is null or char_length(last_error) <= 500),
  add column reconciled_at timestamptz,
  add column attempt integer not null default 1 check (attempt > 0),
  -- Money moved exactly when a payment was posted, and only a `completed` checkout posted one.
  add constraint square_checkout_reconciliation_time check (
    (reconciled_at is not null) = (payment_id is not null)
  );

alter table square_terminal_checkouts drop constraint square_terminal_checkouts_status_check;
alter table square_terminal_checkouts add constraint square_terminal_checkouts_status_check
  check (status in ('pending', 'in_progress', 'canceled', 'failed', 'completed', 'needs_review'));

-- Two starts on one invoice cannot both call themselves the same attempt, which is what would
-- let them derive the same idempotency key for different requests - the one error Square reports
-- as ours rather than its own.
create unique index square_checkout_attempt_per_invoice
  on square_terminal_checkouts (business_id, invoice_id, attempt);
-- The operator's two lists: what is in flight, and what is waiting on a person.
create index square_checkout_open
  on square_terminal_checkouts (business_id, status, created_at)
  where status in ('pending', 'in_progress', 'needs_review');

alter table square_webhook_events drop constraint square_webhook_processed_time;
alter table square_webhook_events drop constraint square_webhook_events_status_check;
alter table square_webhook_events add constraint square_webhook_events_status_check
  check (status in ('pending', 'processed', 'parked', 'failed'));
alter table square_webhook_events add constraint square_webhook_processed_time
  check ((status in ('processed', 'parked')) = (processed_at is not null));

insert into schema_migrations(version) values ('0037_square_terminal_checkout_lifecycle');
commit;
