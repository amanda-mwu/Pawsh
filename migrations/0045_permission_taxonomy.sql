begin;

-- ---------------------------------------------------------------------------
-- Gives the 55 new permission keys to every role that already held all 46, so
-- THE MANAGER GOES ON MEANING "EVERYTHING".
--
-- `permissionPresets.manager` is the whole tuple, and that is load-bearing: it
-- is what stops a new permission needing a migration to reach the Manager. But
-- it only reaches roles being CREATED. `provisionRoleCatalog` deliberately
-- never updates an existing role - a built-in an owner has edited is theirs -
-- so a workspace that already exists holds a `roles.permissions` array frozen
-- at whatever 0041 and 0043 wrote into it. Without this file a salon that
-- signed up this morning would show a Manager granting 101 of 101 while a salon
-- migrated last month showed 46 of 101, same product, same role name, two
-- different roles, and nobody told. That is precisely the drift 0043 existed to
-- repair, one taxonomy earlier.
--
-- Nothing here changes anyone's ACCESS. Every one of the 55 is in
-- `unenforcedPermissions` and no route consults any of them, so this grants
-- switches that gate nothing yet. What it preserves is the guarantee, so that
-- the day one of them is enforced, the role that should already have had it
-- does.
--
-- THE PREDICATE IS RELATIONAL, NOT NOMINAL: "every role that could already do
-- everything". Matching on `name = 'Manager'` would have missed a built-in an
-- owner renamed, and matching on `built_in` would have missed a custom role an
-- owner had granted the full set to - which is a role they built to mean
-- everything, and it should go on meaning that. Containment of the 46 is the
-- honest test of that, and the 46 are spelled out because this file is a
-- historical record from the moment it runs: it must keep describing the tuple
-- as it stood today, not as it stands whenever it is next read.
--
-- Groomer and Receptionist hold neither the full set nor anything close to it,
-- so they are untouched and gain nothing. Correct: they cannot reach any of the
-- features these describe, and the four scope permissions in the set are the
-- ones whose eventual enforcement is meant to restrict exactly those roles.
--
-- Idempotent. A role that has run this holds all 101, still contains the 46,
-- and `array_agg(distinct ...)` adds nothing the second time.
-- ---------------------------------------------------------------------------

update roles
set permissions = (
    select array_agg(distinct permission order by permission)
    from unnest(
      permissions || array[
        'appointments.view_all_staff', 'appointments.edit_all_staff',
        'appointments.service_price_edit', 'appointments.online_booking_accept',
        'checkout.split_tips', 'payments.edit',
        'calendar.blocks_create', 'calendar.blocks_edit',
        'customers.view_all', 'customers.contact_info', 'customers.archive',
        'customers.merge', 'customers.credit_edit', 'customers.bulk_update',
        'customers.export', 'customers.tags_edit', 'pets.breeds_edit',
        'settings.business', 'settings.permissions', 'settings.lock_screen_code',
        'settings.authorize_browser', 'settings.revoke_browser', 'settings.availability',
        'settings.payroll', 'settings.appointment_schedule', 'settings.pet_options',
        'settings.services', 'settings.payments', 'settings.discounts',
        'settings.auto_messages', 'settings.auto_reply', 'settings.mobile',
        'settings.quickbooks', 'settings.google_calendar', 'settings.online_booking',
        'settings.intake_form', 'settings.client_portal', 'settings.review_booster',
        'settings.agreements', 'settings.report_cards', 'report_cards.send',
        'dashboard.all_staff',
        'cash_drawer.manage', 'cash_drawer.delete_records',
        'retail.sale_create', 'settings.retail',
        'settings.packages', 'packages.sell',
        'settings.gift_cards', 'gift_cards.sell',
        'settings.clock_in_out', 'clock_in_out.all_staff',
        'messages.view', 'messages.call_records', 'messages.voicemail'
      ]
    ) as permission
  ),
  -- The role changed, so its optimistic-concurrency token moves with it, for
  -- the same reason 0043 moved it: an editor holding the old version must be
  -- told its copy is stale rather than being allowed to write these grants back
  -- out.
  version = version + 1,
  updated_at = now()
where permissions @> array[
  'calendar.view', 'appointments.view', 'appointments.create', 'appointments.edit',
  'appointments.cancel', 'appointments.override_conflict',
  'customers.view', 'customers.edit',
  'pets.view', 'pets.edit', 'pets.care.view', 'pets.care.edit',
  'operations.check_in', 'operations.perform_service', 'operations.complete',
  'checkout.perform', 'payments.view', 'discounts.apply',
  'services.manage', 'team.manage', 'reports.view', 'settings.manage',
  'dashboard.view', 'dashboard.revenue', 'dashboard.revenue_by_staff',
  'dashboard.commission_by_staff', 'dashboard.tips_by_staff', 'dashboard.sales_items',
  'dashboard.payment_status', 'dashboard.sales_by_method', 'dashboard.summary',
  'payroll.report', 'payroll.commission_by_staff', 'payroll.staff_commission_detail',
  'payroll.clock_in_out_by_staff', 'payroll.clock_in_out_detail', 'payroll.tips_by_staff',
  'payroll.tips_collected_detail', 'payroll.clock_in_out_by_day',
  'payroll.special_service_rates',
  'sales.all', 'sales.by_payment_method', 'sales.by_service', 'sales.by_product',
  'sales.by_staff', 'sales.by_client'
]::text[];

insert into schema_migrations(version) values ('0045_permission_taxonomy');
commit;
