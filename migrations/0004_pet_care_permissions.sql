-- Canonicalize persisted Pet Care permissions without changing effective access.
-- The first occurrence determines stable ordering after substitution/deduplication.
update business_memberships membership
set permissions = (
  select coalesce(array_agg(permission order by first_ordinal), '{}'::text[]) as permissions
  from (
    select case value
      when 'pets.safety.view' then 'pets.care.view'
      when 'pets.safety.edit' then 'pets.care.edit'
      else value
    end as permission,
    min(ordinality) as first_ordinal
    from unnest(membership.permissions) with ordinality as existing(value, ordinality)
    group by case value
      when 'pets.safety.view' then 'pets.care.view'
      when 'pets.safety.edit' then 'pets.care.edit'
      else value
    end
  ) deduplicated
)
where membership.permissions && array['pets.safety.view', 'pets.safety.edit'];

update membership_invitations invitation
set permissions = (
  select coalesce(array_agg(permission order by first_ordinal), '{}'::text[]) as permissions
  from (
    select case value
      when 'pets.safety.view' then 'pets.care.view'
      when 'pets.safety.edit' then 'pets.care.edit'
      else value
    end as permission,
    min(ordinality) as first_ordinal
    from unnest(invitation.permissions) with ordinality as existing(value, ordinality)
    group by case value
      when 'pets.safety.view' then 'pets.care.view'
      when 'pets.safety.edit' then 'pets.care.edit'
      else value
    end
  ) deduplicated
)
where invitation.permissions && array['pets.safety.view', 'pets.safety.edit'];
