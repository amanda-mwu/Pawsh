begin;

-- ---------------------------------------------------------------------------
-- Square Terminal: credentials, devices, checkouts and the webhook inbox.
--
-- 0034 said this plainly: a salon may record which processor it uses, but it may not connect
-- one, because there was no OAuth flow, no credential store and no pairing state to represent.
-- This migration is the thing 0034 said would come, and it adds its own tables rather than
-- widening `card_processors`. Nothing recorded there has to be retracted: a `card_processors`
-- row is still the salon's own note about the machine on its counter, and a
-- `card_processor_terminals` row is still an inventory record. A paired Square device is a
-- different object with a different lifetime - it is issued by Square, it expires, and it stops
-- existing when the merchant revokes us - so it gets its own row rather than nullable columns
-- bolted onto an inventory record that would then be half fact and half session.
--
-- CREDENTIALS ARE BUSINESS-SCOPED, NOT PER LOCATION. `square_connections.business_id` is UNIQUE.
-- One Square merchant authorises Pawsh once; the several Square locations that merchant owns are
-- selected per device, not per credential. Keying credentials by location would mean a salon
-- with two rooms holds two refresh tokens for the same merchant, and revoking one would leave
-- the other believing it is still connected.
--
-- TOKENS ARE SEALED, AND THE ROW SAYS WHICH KEY SEALED THEM. `access_token` and `refresh_token`
-- hold envelope-encrypted values, never plaintext, and `key_version` records the integration key
-- that sealed them so a rotation can find every row still resting on a retiring key without
-- trial-decrypting the table. A revoked or disconnected connection holds no tokens at all -
-- `square_connection_token_presence` makes "revoked but still has credentials" unrepresentable
-- rather than merely unlikely.
--
-- MERCHANT ID IS THE ONLY KEY A REVOCATION WEBHOOK CARRIES. `oauth.authorization.revoked` names
-- a merchant and an application, and nothing else; there is no business id in it. So the lookup
-- has to run on `square_merchant_id`, which is indexed and deliberately NOT unique. A revocation
-- kills every token Square ever issued this application for that merchant, so the handler marks
-- every matching connection revoked. Making the column unique would invent a rule Square does
-- not enforce - one merchant, one Pawsh business - and would fail an owner who runs two salons
-- through one Square account at exactly the moment they tried to connect the second.
--
-- DEVICE ROWS HOLD PAIRING STATE, WHICH `card_processor_terminals` DELIBERATELY DOES NOT. A
-- device code is issued by Square, and either becomes a device id or expires. How long it lasts
-- is Square's to say and Square's published answers do not agree with each other, so this column
-- holds the `pair_by` instant parsed from the response that issued the code and no number is
-- written down here to be believed later. `square_device_pairing_consistency` ties the pairing
-- columns together so a row cannot claim to be paired without the device id and the moment it
-- happened.
--
-- CHECKOUTS ARE INTENTS, PAYMENTS ARE THE LEDGER. There is no `square_payments` table. A Square
-- payment lands in `payments` like every other payment, and `square_terminal_checkouts` records
-- the intent that produced it, the idempotency key that made the request safe to retry, and -
-- where the money that came back disagreed with the money asked for - a `mismatch` document and
-- a `needs_review` status. A checkout that never became money keeps `payment_id` null, and the
-- invoice's balance is untouched by anything in this file.
--
-- THE PARTIAL UNIQUE INDEX ON `payments` IS THE STRUCTURAL GUARANTEE AGAINST DOUBLE-POSTING.
-- Square retries a webhook about eleven times over twenty-four hours, and our own reconciliation
-- may reach the same payment from a poll and from a webhook in the same second. Application code
-- that checks first and inserts second loses that race. `payment_provider_reference` cannot: two
-- postings of one Square payment id inside one business are a unique violation, in the database,
-- under concurrency, regardless of which path got there first.
--
-- THE WEBHOOK INBOX MIRRORS `outbox_events` ON PURPOSE. Same claim columns - `attempts`,
-- `next_attempt_at`, `processed_at`, `last_error` - so the same `for update skip locked` drain
-- reads it. Receiving is not processing: the receiver verifies a signature, writes the row and
-- answers Square, and every decision about what the event means happens later in the worker. Its
-- `business_id` is nullable because at the moment of receipt we have a merchant id and nothing
-- else, and inventing a tenant before the lookup succeeds would be a guess written to disk.
-- ---------------------------------------------------------------------------

create table square_connections (
  id uuid primary key default gen_random_uuid(),
  -- UNIQUE: credentials belong to the business, never to a location.
  business_id uuid not null unique references businesses(id),
  environment text not null check (environment in ('sandbox', 'production')),
  square_merchant_id text not null check (char_length(btrim(square_merchant_id)) between 1 and 64),
  -- Sealed envelopes produced by the integration keyring, never plaintext, and null once the
  -- connection stops being one.
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  scopes text[] not null default '{}',
  status text not null check (status in ('connected', 'revoked', 'disconnected')),
  key_version integer not null check (key_version > 0),
  connected_at timestamptz not null default now(),
  refreshed_at timestamptz,
  revoked_at timestamptz,
  -- Refresh is scheduled, not lazy. Square asks for a refresh every seven days or fewer
  -- regardless of whether the token was used, so the worker needs somewhere to record when it
  -- should next try and how many times it has failed; without these a failing refresh would be
  -- retried on every fifteen-second worker tick.
  next_refresh_at timestamptz not null default now(),
  refresh_attempts integer not null default 0 check (refresh_attempts >= 0),
  last_refresh_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  constraint square_connection_token_presence check (
    (status = 'connected' and access_token is not null and refresh_token is not null)
    or (status <> 'connected' and access_token is null and refresh_token is null)
  ),
  constraint square_connection_revocation_time check (
    (status = 'revoked') = (revoked_at is not null)
  )
);

-- Deliberately not unique: see the merchant-id note above.
create index square_connection_merchant
  on square_connections (environment, square_merchant_id);
-- The worker's claim order. Only connected rows are ever refreshed.
create index square_connection_refresh_due
  on square_connections (next_refresh_at) where status = 'connected';

-- ---------------------------------------------------------------------------
-- The state parameter Square echoes back.
--
-- Square treats `state` as an opaque string it returns unchanged; it binds nothing and checks
-- nothing. Every property that makes it a defence has to be ours, and two of them - single use
-- and replay rejection - cannot be carried inside a self-describing signed token, because
-- refusing a second presentation of a valid token requires remembering that the first happened.
-- Hence a row. Only the SHA-256 of the state is stored, exactly as `sessions.token_hash` stores
-- only the hash of a session token: a database backup must not hand anybody a live state value.
-- ---------------------------------------------------------------------------

create table square_oauth_states (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  environment text not null check (environment in ('sandbox', 'production')),
  redirect_uri text not null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index square_oauth_state_expiry on square_oauth_states (expires_at);

create table square_devices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  location_id uuid not null,
  -- Which Square location this terminal takes money for. The list of a merchant's locations is
  -- fetched live during pairing and never mirrored into a table of our own, because a stale
  -- mirror of somebody else's locations is worse than no mirror.
  square_location_id text not null check (char_length(btrim(square_location_id)) between 1 and 64),
  label text not null check (char_length(btrim(label)) between 1 and 60),
  device_code_id text,
  device_code text,
  pair_by timestamptz,
  pairing_status text not null default 'unpaired'
    check (pairing_status in ('unpaired', 'paired', 'expired')),
  square_device_id text,
  paired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, location_id) references locations(business_id, id),
  constraint square_device_pairing_consistency check (
    (pairing_status = 'paired' and square_device_id is not null and paired_at is not null)
    or (pairing_status <> 'paired' and square_device_id is null and paired_at is null)
  )
);

-- `device.code.paired` arrives with a device-code id and no tenant, so this is the lookup that
-- resolves the business. Unique across the whole table rather than per business because the id
-- is Square's, and two of our rows claiming the same one would make the resolution ambiguous.
create unique index square_device_code_identifier
  on square_devices (device_code_id) where device_code_id is not null;
create index square_device_location on square_devices (business_id, location_id, label);

-- `payments` has never carried `unique (business_id, id)`, so nothing could reference a payment
-- by tenant-qualified key. A checkout that points at a payment must not be able to point at
-- another business's payment, and the only way to say that as a foreign key is to give the
-- target the composite key every other tenant-owned table here already has.
alter table payments add constraint payments_business_scoped_key unique (business_id, id);

create table square_terminal_checkouts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  invoice_id uuid not null,
  device_id uuid not null,
  square_checkout_id text,
  -- Square's Terminal idempotency key is at most 45 characters.
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 45),
  amount_minor integer not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'canceled', 'completed', 'needs_review')),
  -- What the terminal returned when it disagreed with what was asked for: a different amount, a
  -- different currency, a payment against an invoice that had already been settled. Held as a
  -- document rather than as columns because the shape of a disagreement is not knowable up
  -- front, and a person has to read it before the money moves.
  mismatch jsonb,
  payment_id uuid,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, invoice_id) references invoices(business_id, id),
  foreign key (business_id, device_id) references square_devices(business_id, id),
  foreign key (business_id, payment_id) references payments(business_id, id)
);

create unique index square_checkout_identifier_per_business
  on square_terminal_checkouts (business_id, square_checkout_id) where square_checkout_id is not null;
create unique index square_checkout_idempotency_per_business
  on square_terminal_checkouts (business_id, idempotency_key);
create index square_checkout_invoice on square_terminal_checkouts (business_id, invoice_id, created_at);

create table square_webhook_events (
  id uuid primary key default gen_random_uuid(),
  -- Square's own event id. UNIQUE, and that is the whole dedupe strategy: a redelivery is an
  -- insert that conflicts, which the receiver reports as an acknowledgement rather than an error.
  event_id text not null unique check (char_length(btrim(event_id)) between 1 and 128),
  merchant_id text not null check (char_length(btrim(merchant_id)) between 1 and 64),
  -- Null until a merchant lookup resolves it, and left null forever for an event about a
  -- merchant we have no connection to.
  business_id uuid references businesses(id),
  event_type text not null check (char_length(btrim(event_type)) between 1 and 128),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'processed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  constraint square_webhook_processed_time check ((status = 'processed') = (processed_at is not null))
);

-- Mirrors `outbox_pending` so the same claim query plans the same way.
create index square_webhook_pending on square_webhook_events (next_attempt_at)
  where processed_at is null;
create index square_webhook_merchant on square_webhook_events (merchant_id, received_at);

-- ---------------------------------------------------------------------------
-- `payments` gains a provider identity.
--
-- Nullable throughout: every payment recorded before today, and every cash, check and
-- external-card payment recorded after it, has no provider and must stay valid unchanged.
-- `payment_provider_identity` refuses the half-filled shape - a provider with no reference, or a
-- reference belonging to no provider - because either one would sit outside the unique index
-- that exists to stop the same Square payment being posted twice.
-- ---------------------------------------------------------------------------

alter table payments
  add column provider text check (provider in ('square')),
  add column provider_payment_id text,
  add column provider_tip_minor integer check (provider_tip_minor >= 0),
  add constraint payment_provider_identity check (
    (provider is null and provider_payment_id is null)
    or (provider is not null and provider_payment_id is not null)
  );

create unique index payment_provider_reference
  on payments (business_id, provider, provider_payment_id) where provider is not null;

-- ---------------------------------------------------------------------------
-- Tenant isolation, as every tenant-owned table in this schema carries it.
--
-- `square_webhook_events` is the one exception in shape, and it is stated rather than implied.
-- Two facts pull against each other. A row arrives before its tenant is known, written by a
-- receiver that has no session, no business and therefore no `app.business_id` at all - so bare
-- equality would refuse the insert the table exists for, and the events would be dropped. But an
-- unconditional "or business_id is null" arm would let ANY salon's session read every unresolved
-- row in the table: other merchants' ids, device codes, and raw payloads. That is a cross-tenant
-- read, and it is not made acceptable by the rows being temporary.
--
-- So the axis is the CONTEXT, not the column. With no `app.business_id` set - the receiver, and
-- the worker drain that resolves the tenant afterwards - this is the system's inbox and is
-- reachable. With `app.business_id` set, the ordinary equality applies and nothing else is
-- visible: a salon session sees its own resolved rows and never a pending one.
--
-- The same predicate is used for `with check`, and both halves of that matter. It lets the drain
-- perform the write that fills `business_id` in, which a policy phrased as "null rows only, when
-- there is no tenant" would refuse at check time - the new row has a business id while the
-- session still has none. And it stops a tenant session writing a `business_id is null` row,
-- which would otherwise be a way to park data outside every other tenant's view.
-- ---------------------------------------------------------------------------

do $$
declare
  target text;
begin
  foreach target in array array[
    'square_connections', 'square_oauth_states', 'square_devices', 'square_terminal_checkouts'
  ] loop
    execute format('alter table %I enable row level security', target);
    execute format(
      'create policy tenant_isolation on %I using (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid) with check (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)',
      target
    );
  end loop;
end $$;

alter table square_webhook_events enable row level security;
create policy tenant_isolation on square_webhook_events
using (
  nullif(current_setting('app.business_id', true), '') is null
  or business_id = nullif(current_setting('app.business_id', true), '')::uuid
)
with check (
  nullif(current_setting('app.business_id', true), '') is null
  or business_id = nullif(current_setting('app.business_id', true), '')::uuid
);

insert into schema_migrations(version) values ('0036_square_terminal_integration');
commit;
