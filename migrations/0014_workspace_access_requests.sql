begin;

alter table sessions add column business_id uuid references businesses(id);

alter table business_memberships add unique (business_id,id);
alter table membership_invitations add unique (business_id,id);

update sessions session
set business_id=(
  select membership.business_id from business_memberships membership
  where membership.user_id=session.user_id and membership.status='active'
  order by membership.created_at limit 1
)
where business_id is null;

create table workspace_access_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  requester_name text not null check (char_length(btrim(requester_name)) between 1 and 120),
  requester_email text not null,
  normalized_email text not null,
  message text check (message is null or char_length(message)<=1000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_at timestamptz,
  reviewed_by uuid references users(id),
  membership_id uuid,
  invitation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status='pending' and reviewed_at is null and reviewed_by is null)
    or (status<>'pending' and reviewed_at is not null and reviewed_by is not null)),
  foreign key (business_id,membership_id) references business_memberships(business_id,id),
  foreign key (business_id,invitation_id) references membership_invitations(business_id,id)
);

create unique index one_pending_workspace_access_request
  on workspace_access_requests(business_id,normalized_email) where status='pending';
create index workspace_access_requests_review
  on workspace_access_requests(business_id,status,created_at desc);

alter table workspace_access_requests enable row level security;
create policy tenant_isolation on workspace_access_requests
  using (business_id=nullif(current_setting('app.business_id',true),'')::uuid)
  with check (business_id=nullif(current_setting('app.business_id',true),'')::uuid);

commit;
