begin;

create table financial_idempotency_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  operation text not null check (operation in ('checkout.create-invoice','payment.record','payment.void')),
  idempotency_key uuid not null,
  initiating_actor_id uuid not null references users(id),
  canonical_payload_hash text not null check (canonical_payload_hash ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('in_progress','completed')),
  result_type text,
  result_resource_id uuid,
  result_metadata jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (business_id,operation,idempotency_key),
  check ((state='completed' and result_resource_id is not null and result_metadata is not null and completed_at is not null)
    or (state='in_progress' and result_resource_id is null and result_metadata is null and completed_at is null))
);

create index financial_idempotency_expiry
  on financial_idempotency_requests(expires_at,id) where state='completed';

alter table invoices
  add column intent_fingerprint text check (intent_fingerprint is null or intent_fingerprint ~ '^[0-9a-f]{64}$'),
  add column calculation_version integer not null default 1 check (calculation_version > 0),
  add column tax_rate_basis_points integer not null default 0 check (tax_rate_basis_points between 0 and 10000),
  add constraint invoice_total_components check (
    total_minor = subtotal_minor - discount_minor + tax_minor + tip_minor
  ),
  add constraint invoice_balance_bounds check (balance_minor between 0 and total_minor);

alter table invoice_items add column line_position integer;

with positions as (
  select id,row_number() over (partition by invoice_id order by source_appointment_service_id,id)::integer as position
  from invoice_items
)
update invoice_items item set line_position=positions.position from positions where positions.id=item.id;

alter table invoice_items
  alter column line_position set not null,
  add constraint invoice_item_position_positive check (line_position > 0),
  add constraint invoice_item_position_unique unique (invoice_id,line_position);

alter table financial_idempotency_requests enable row level security;
create policy tenant_financial_idempotency_requests on financial_idempotency_requests
using (business_id = nullif(current_setting('app.business_id', true),'')::uuid)
with check (business_id = nullif(current_setting('app.business_id', true),'')::uuid);

commit;
