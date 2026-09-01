begin;

-- ---------------------------------------------------------------------------
-- Grants the new report and dashboard permissions to every role that could
-- already reach reports, so NOBODY'S ACCESS CHANGES.
--
-- The taxonomy adds two things at once. `dashboard.view` splits `GET
-- /api/dashboard` off `reports.view`, which on its own would take the dashboard
-- away from every existing reports user. And a set of children narrow WHAT
-- comes back from the two report endpoints by omitting fields from the
-- response - so a role holding the master but none of the children would keep
-- its access to the endpoints while losing most of the figures in them.
--
-- Both are silent revocations, and neither is anything an owner asked for. So
-- every role that holds `reports.view` today receives the whole new set: the
-- master it is being split into, and every child of both masters. A role that
-- could see everything reporting had to offer goes on seeing everything.
--
-- Roles WITHOUT `reports.view` are untouched and gain nothing. The Groomer and
-- Receptionist presets carry no `reports.view`, so the roles 0041 seeded from
-- them are unaffected, which is correct: they could not reach reports before
-- and must not begin to now.
--
-- `permissionPresets.manager` is the whole tuple and so picks the new strings
-- up in code with no help from here. This file is only about the roles that
-- already exist in customer data.
--
-- Note this runs AFTER 0042 dropped the denormalised columns, which is why it
-- has exactly one place to write: `roles.permissions`. Had it run earlier it
-- would have had three, and the three could have disagreed.
-- ---------------------------------------------------------------------------

update roles
set permissions = (
    select array_agg(distinct permission order by permission)
    from unnest(
      permissions || array[
        'dashboard.view',
        'dashboard.revenue', 'dashboard.revenue_by_staff', 'dashboard.commission_by_staff',
        'dashboard.tips_by_staff', 'dashboard.sales_items', 'dashboard.payment_status',
        'dashboard.sales_by_method', 'dashboard.summary',
        'payroll.report', 'payroll.commission_by_staff', 'payroll.staff_commission_detail',
        'payroll.clock_in_out_by_staff', 'payroll.clock_in_out_detail', 'payroll.tips_by_staff',
        'payroll.tips_collected_detail', 'payroll.clock_in_out_by_day',
        'payroll.special_service_rates',
        'sales.all', 'sales.by_payment_method', 'sales.by_service', 'sales.by_product',
        'sales.by_staff', 'sales.by_client'
      ]
    ) as permission
  ),
  -- The role changed, so its optimistic-concurrency token moves with it. An
  -- editor holding the old version must be told its copy is stale rather than
  -- being allowed to write these grants back out.
  version = version + 1,
  updated_at = now()
where 'reports.view' = any(permissions);

insert into schema_migrations(version) values ('0043_report_dashboard_taxonomy');
commit;
