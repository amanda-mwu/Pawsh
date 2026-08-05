create unique index membership_business_identity
  on business_memberships (business_id,id);

alter table pets
  add column rabies_vaccination_date date,
  add column rabies_certificate_reference text,
  add column rabies_verification_status text not null default 'not_provided',
  add column rabies_verification_method text,
  add column rabies_verified_at timestamptz,
  add column rabies_verified_by_membership_id uuid,
  add constraint pet_rabies_reference_length check (
    rabies_certificate_reference is null or char_length(rabies_certificate_reference) <= 200
  ),
  add constraint pet_rabies_verification_status check (
    rabies_verification_status in ('not_provided','unverified','staff_verified')
  ),
  add constraint pet_rabies_verification_method check (
    rabies_verification_method is null or rabies_verification_method in (
      'document_review','veterinarian_confirmation','verbal_confirmation','customer_provided','other'
    )
  ),
  add constraint pet_rabies_date_order check (
    rabies_vaccination_date is null or vaccination_expires_on is null
    or vaccination_expires_on >= rabies_vaccination_date
  ),
  add constraint pet_rabies_verification_consistency check (
    (rabies_verification_status='staff_verified'
      and vaccination_expires_on is not null
      and rabies_verification_method is not null
      and rabies_verified_at is not null
      and rabies_verified_by_membership_id is not null)
    or
    (rabies_verification_status<>'staff_verified'
      and rabies_verification_method is null
      and rabies_verified_at is null
      and rabies_verified_by_membership_id is null)
  ),
  add foreign key (business_id,rabies_verified_by_membership_id)
    references business_memberships(business_id,id);

update pets set rabies_verification_status=case
  when vaccination_expires_on is null then 'not_provided'
  else 'unverified'
end;

alter table notification_intents
  drop constraint notification_intents_status_check,
  alter column destination drop not null,
  add column recipient_kind text not null default 'customer',
  add column recipient_membership_id uuid,
  add column material_key text,
  add column resolved_at timestamptz,
  add constraint notification_intents_status_check
    check (status in ('pending','sending','sent','failed','cancelled','suppressed')),
  add constraint notification_recipient_kind_check
    check (recipient_kind in ('customer','staff')),
  add constraint notification_destination_consistency check (
    destination is not null or status in ('suppressed','cancelled')
  ),
  add foreign key (business_id,recipient_membership_id)
    references business_memberships(business_id,id);

create unique index unique_notification_material_recipient
  on notification_intents (business_id,material_key,recipient_kind,
    coalesce(customer_id,'00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(recipient_membership_id,'00000000-0000-0000-0000-000000000000'::uuid))
  where material_key is not null;

create index appointment_rabies_reconciliation
  on appointments (business_id,pet_id,status,scheduled_local_start);

create index notification_rabies_state
  on notification_intents (business_id,appointment_id,notification_type,status)
  where notification_type in ('rabies_expiration_customer','rabies_expiration_staff');

insert into schema_migrations(version) values ('0010_rabies_appointment_compliance');
