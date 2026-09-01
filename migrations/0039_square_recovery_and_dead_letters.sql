begin;

-- ---------------------------------------------------------------------------
-- Recovering the payments nobody came back for, and the events nobody can act on.
--
-- 0036 through 0038 built a capture path whose every write is safe to repeat: a derived
-- idempotency key, a row claimed before Square is called, and a partial unique index that refuses
-- a second posting of one Square payment. What they did not build is anything that repeats those
-- writes on its own. Recovery was a webhook that arrives or a person who presses refresh, and both
-- of those can simply not happen. This migration adds the columns that let a worker be the third
-- path, and the resting states that stop a row waiting forever for a caller that is not coming.
--
-- PROVIDER IDENTITIES BECOME GLOBALLY UNIQUE, BECAUSE THE LOOKUPS ALREADY WERE. A
-- `terminal.checkout.updated` event carries a Square checkout id and no tenant, so the query that
-- resolves it to a Pawsh business cannot filter by `business_id` - there is nothing to filter by
-- yet. The same is true of `refund.updated` and a Square refund id. Both lookups were written that
-- way and both were backed by indexes that were unique only WITHIN a business, so two rows in
-- different businesses could hold one Square id and the resolution would return an arbitrary one
-- of them - which is to say it could post a payment into the wrong salon's ledger. That is not
-- hypothetical by design: 0036 deliberately allows one Square merchant to authorise two Pawsh
-- businesses. `square_device_code_identifier` in 0036 already got this exactly right, and said
-- why: the id is Square's, and two of our rows claiming the same one would make the resolution
-- ambiguous. The two indexes below apply that same reasoning to the two identities that move
-- money. Each is strictly stronger than the per-business index it replaces - everything the old
-- index refused, the new one also refuses - so nothing that was rejected before is now allowed.
--
-- A CHECKOUT AND A REFUND GET A CLAIM SCHEDULE, THE SAME ONE EVERY OTHER WORKER IN THIS SCHEMA
-- USES. `next_sweep_at` and `sweep_attempts` are `square_connections.next_refresh_at` /
-- `refresh_attempts` and `square_webhook_events.next_attempt_at` / `attempts` under a third name,
-- so the sweep claims with the same `for update skip locked` and backs off the same way. The claim
-- itself moves the timestamp forward, which is what makes a crash between claiming and finishing
-- cost a delay rather than a hot loop against Square. Existing open rows take `now()` and are
-- therefore swept on the next tick, which is correct: an open checkout that predates this
-- migration is precisely the orphan the sweep exists to find.
--
-- A REFUND GAINS `needs_review`, WHICH IS THE STATE IT WAS MISSING. 0038 gave refunds
-- `pending -> completed | failed` and argued, correctly, that both terminal values are claims
-- about money: `completed` says the customer got it back, `failed` says they did not. When Square
-- reports a refund that is not the one we asked for, neither claim is true and the code had
-- nowhere to put the row, so it left it `pending` - holding its headroom, in the sweep's way, and
-- indistinguishable on screen from a refund that is merely still in flight. `needs_review` is not
-- a fourth claim about money. It is the absence of one, said out loud, and it is exactly what
-- `square_terminal_checkouts` has had since 0036 for the identical situation. `mismatch` carries
-- the disagreement as a document for the same reason it does there: the shape of a disagreement is
-- not knowable up front, and a person has to read it before anything else happens.
--
-- AN EVENT THAT CANNOT BE PROCESSED COMES TO REST AS `dead_letter`. 0037 widened
-- `square_webhook_processed_time` from one resting state to two so that `parked` could stop the
-- drain claiming a row. This widens it to three for the same mechanical reason. The three are
-- different facts and stay different: `processed` is "we acted on this", `parked` is "we saw it
-- and it is not ours", and `dead_letter` is "we tried, we kept failing, and we have stopped".
-- Without it a permanently failing event is retried every hour forever and no operator surface can
-- distinguish it from one that will succeed on the next attempt.
--
-- NO RETENTION IS ADDED HERE, AND THAT IS DELIBERATE. `square_webhook_events.event_id` being
-- UNIQUE is not merely the dedupe - it is the ONLY thing that refuses a replayed notification,
-- because nothing in the receiver checks how old a body is. Deleting old rows would therefore
-- restore the ability to replay every event whose row had aged out, using a signature that is
-- still valid because the signing key has not changed. Whoever adds retention to this table must
-- add a timestamp window to the receiver in the same change, or they will have quietly removed
-- replay protection while appearing to do housekeeping.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Global provider identities.
--
-- Tightening a unique index cannot assume the data already satisfies it. If two rows in different
-- businesses already share one Square id, this migration must stop and say which, because the two
-- rows are a real ambiguity about whose ledger a payment belongs in and no automatic choice
-- between them is defensible - picking one would be the same arbitrary answer the broken lookup
-- was already giving, written down permanently. This follows 0032, which refuses to run rather
-- than silently repricing a salon's book.
-- ---------------------------------------------------------------------------

do $$
declare
  offenders text;
begin
  select string_agg(square_checkout_id, ', ' order by square_checkout_id) into offenders
  from (
    select square_checkout_id from square_terminal_checkouts
    where square_checkout_id is not null
    group by square_checkout_id having count(*) > 1
  ) duplicated;
  if offenders is not null then
    raise exception 'Square checkout ids held by more than one Pawsh checkout row: %. Reconciliation resolves an event to a business through this id, so it must name exactly one row. Resolve these by hand before applying 0039.', offenders;
  end if;

  select string_agg(provider_refund_id, ', ' order by provider_refund_id) into offenders
  from (
    select provider_refund_id from payment_refunds
    where provider_refund_id is not null
    group by provider_refund_id having count(*) > 1
  ) duplicated;
  if offenders is not null then
    raise exception 'Square refund ids held by more than one Pawsh refund row: %. A refund.updated event resolves to a business through this id, so it must name exactly one row. Resolve these by hand before applying 0039.', offenders;
  end if;
end $$;

-- Named after `square_device_code_identifier`, which is the same shape for the same reason: an
-- identifier that is Square's, resolved from an event that carries no tenant.
create unique index square_checkout_identifier
  on square_terminal_checkouts (square_checkout_id) where square_checkout_id is not null;
drop index square_checkout_identifier_per_business;

create unique index payment_refund_identifier
  on payment_refunds (provider, provider_refund_id) where provider_refund_id is not null;
drop index payment_refund_provider_reference;

-- ---------------------------------------------------------------------------
-- The sweep's claim schedule.
-- ---------------------------------------------------------------------------

alter table square_terminal_checkouts
  add column next_sweep_at timestamptz not null default now(),
  add column sweep_attempts integer not null default 0 check (sweep_attempts >= 0);

alter table payment_refunds
  add column next_sweep_at timestamptz not null default now(),
  add column sweep_attempts integer not null default 0 check (sweep_attempts >= 0);

-- The sweep's claim order. Only rows a further read could still change are ever claimed, which is
-- what keeps a settled checkout and a completed refund out of the index entirely.
create index square_checkout_sweep_due on square_terminal_checkouts (next_sweep_at)
  where status in ('pending', 'in_progress');
create index payment_refund_sweep_due on payment_refunds (next_sweep_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- A refund that needs a person.
-- ---------------------------------------------------------------------------

alter table payment_refunds add column mismatch jsonb;

alter table payment_refunds drop constraint payment_refunds_status_check;
alter table payment_refunds add constraint payment_refunds_status_check
  check (status in ('pending', 'completed', 'failed', 'needs_review'));

-- A refund waiting on a person must say what it is waiting about. `needs_review` with no document
-- is a row an operator can see and cannot act on, and a document on a row nobody is being asked to
-- look at is a note in a drawer.
alter table payment_refunds add constraint payment_refund_review_document
  check ((status = 'needs_review') = (mismatch is not null));

-- `needs_review` carries a sentence in `failure_reason` too - the operator reads that before they
-- open the document - so it joins `pending` as a state where the column is simply free.
alter table payment_refunds drop constraint payment_refund_failure_reason;
alter table payment_refunds add constraint payment_refund_failure_reason
  check (
    (status = 'failed' and failure_reason is not null)
    or (status = 'completed' and failure_reason is null)
    or status in ('pending', 'needs_review')
  );

-- A refund reaches `needs_review` only after Square named the refund it settled, so in practice it
-- always carries a reference. The arm is widened anyway rather than relying on that: the rule this
-- constraint states is "a reference may never appear without a provider", and which non-completed
-- states are allowed to be waiting for one is not the thing it is trying to police.
alter table payment_refunds drop constraint payment_refund_provider_identity;
alter table payment_refunds add constraint payment_refund_provider_identity
  check (
    (provider is null and provider_refund_id is null)
    or (provider is not null and provider_refund_id is not null)
    or (provider is not null and provider_refund_id is null
        and status in ('pending', 'failed', 'needs_review'))
  );

-- The operator's list, beside `square_checkout_open` which has been the checkout equivalent since
-- 0037. A refund waiting on a person is not waiting on the drain, so it is a different index.
create index payment_refund_review on payment_refunds (business_id, created_at)
  where status = 'needs_review';

-- ---------------------------------------------------------------------------
-- An event the drain has given up on.
-- ---------------------------------------------------------------------------

alter table square_webhook_events drop constraint square_webhook_events_status_check;
alter table square_webhook_events add constraint square_webhook_events_status_check
  check (status in ('pending', 'processed', 'parked', 'failed', 'dead_letter'));

alter table square_webhook_events drop constraint square_webhook_processed_time;
alter table square_webhook_events add constraint square_webhook_processed_time
  check ((status in ('processed', 'parked', 'dead_letter')) = (processed_at is not null));

-- What an operator has to be shown: the events this deployment could not act on. Not indexed with
-- `business_id` leading, because a dead letter frequently never resolved to a tenant at all - that
-- is often the very reason it died.
create index square_webhook_dead_letter on square_webhook_events (received_at)
  where status = 'dead_letter';

insert into schema_migrations(version) values ('0039_square_recovery_and_dead_letters');
commit;
