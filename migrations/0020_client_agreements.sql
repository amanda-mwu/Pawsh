begin;

-- ---------------------------------------------------------------------------
-- 1. Agreement templates
--
-- A salon authors the documents its clients agree to ("Cancellation Policy",
-- "Matted Pet Release Form", ...). A template is business-owned content, so it
-- carries the same composite `(business_id, id)` identity every other tenant
-- table exposes, and every reference to it below is a composite foreign key: a
-- customer of one business can never be pointed at another business's document.
--
-- Templates are archived (`active=false`), never deleted, because a signature
-- recorded against one has to stay explainable after the salon stops using it.
-- `version` increments whenever the agreed-to content changes (name, body, or
-- whether it is required), so a recorded signature can say which revision of the
-- document it was recorded against.
-- ---------------------------------------------------------------------------

create table agreement_templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 20000),
  required boolean not null default false,
  active boolean not null default true,
  version integer not null default 1 check (version > 0),
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);

-- Two live documents with the same name are indistinguishable to staff choosing
-- what to send. Archived names are released so a salon can re-author a policy.
create unique index agreement_template_live_name
  on agreement_templates (business_id, lower(btrim(name))) where active;
-- Supports the "which documents must this client have signed?" scan behind the
-- profile warning banner.
create index agreement_template_required_live
  on agreement_templates (business_id) where required and active;
create index agreement_template_listing
  on agreement_templates (business_id, active, lower(btrim(name)));

-- ---------------------------------------------------------------------------
-- 2. Per-customer agreement state
--
-- A row exists only once something has actually happened: the agreement was
-- sent, or a signature was recorded. "Not sent" is therefore the absence of a
-- row, which keeps the table free of one placeholder row per client per
-- document and makes the resolved state a left join rather than a backfill
-- obligation every time a template is created.
--
-- This is deliberately NOT an e-signature record. There is no client-facing
-- signing surface in Pawsh: a signature is staff-recorded provenance (the name
-- the client gave, when, which staff member recorded it, and against which
-- revision of the document), which is exactly what `signature_method` names.
-- ---------------------------------------------------------------------------

create table customer_agreements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  customer_id uuid not null,
  agreement_template_id uuid not null,
  status text not null check (status in ('sent', 'signed')),
  -- "queued for delivery at", not "the client received it at": delivery is
  -- asynchronous and its real outcome lives on notification_intents.
  sent_at timestamptz,
  send_count integer not null default 0 check (send_count >= 0),
  last_sent_channel text check (last_sent_channel is null or last_sent_channel in ('email')),
  last_sent_by_membership_id uuid,
  signed_at timestamptz,
  signed_name text check (signed_name is null or char_length(btrim(signed_name)) between 1 and 120),
  signature_method text check (signature_method is null or signature_method in ('staff_recorded')),
  signature_note text check (signature_note is null or char_length(signature_note) <= 500),
  signed_template_version integer check (signed_template_version is null or signed_template_version > 0),
  signed_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, customer_id, agreement_template_id),
  -- One document per client has exactly one state, and a "signed" row can never
  -- be missing its provenance while an unsigned row can never carry any.
  constraint customer_agreement_state_consistency check (
    (status = 'sent'
      and sent_at is not null
      and signed_at is null and signed_name is null and signature_method is null
      and signature_note is null and signed_template_version is null
      and signed_by_membership_id is null)
    or
    (status = 'signed'
      and signed_at is not null and signed_name is not null
      and signature_method is not null and signed_template_version is not null
      and signed_by_membership_id is not null)
  ),
  foreign key (business_id, customer_id) references customers(business_id, id) on delete cascade,
  foreign key (business_id, agreement_template_id) references agreement_templates(business_id, id),
  foreign key (business_id, last_sent_by_membership_id) references business_memberships(business_id, id),
  foreign key (business_id, signed_by_membership_id) references business_memberships(business_id, id)
);

create index customer_agreement_by_template
  on customer_agreements (business_id, agreement_template_id, status);

-- ---------------------------------------------------------------------------
-- 3. Sending
--
-- Sending reuses the existing notification outbox rather than introducing a
-- second transport. `channel` stays `check (channel in ('email'))`: Pawsh has no
-- SMS transport, and widening the enum without one would only let the product
-- claim a delivery it cannot perform.
--
-- The partial unique index means a client can have at most one *undelivered*
-- request outstanding per document, which is what makes the send endpoint
-- idempotent: pressing send twice queues one message. Once that message reaches
-- a terminal state ('sent' / 'cancelled'), a later send is a genuine new nudge
-- and is allowed.
-- ---------------------------------------------------------------------------

alter table notification_intents
  add column agreement_template_id uuid,
  add constraint notification_agreement_requires_customer check (
    agreement_template_id is null or customer_id is not null
  ),
  add foreign key (business_id, agreement_template_id)
    references agreement_templates(business_id, id);

create unique index one_open_agreement_notification
  on notification_intents (business_id, customer_id, agreement_template_id)
  where agreement_template_id is not null and status in ('pending', 'sending', 'failed');

-- ---------------------------------------------------------------------------
-- 4. Row-level security, consistent with the neighbouring tenant tables.
-- ---------------------------------------------------------------------------

alter table agreement_templates enable row level security;
create policy tenant_isolation on agreement_templates
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

alter table customer_agreements enable row level security;
create policy tenant_isolation on customer_agreements
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- No default templates are seeded. Agreement bodies are the salon's own legal
-- text, a seeded `required` document would flip every existing client into the
-- unsigned-agreements warning banner on deploy, and a seeded placeholder body is
-- exactly the content that must never be emailed to a client. Template creation
-- stays an explicit act by the business.

insert into schema_migrations(version) values ('0020_client_agreements');
commit;
