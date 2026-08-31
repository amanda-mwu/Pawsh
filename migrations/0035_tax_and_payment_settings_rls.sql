begin;

-- ---------------------------------------------------------------------------
-- Row-level tenant isolation for the tax and payment configuration tables.
--
-- 0034 created the five tables without it. Every other tenant-owned table in this schema carries
-- `tenant_isolation` - 0001 applied it in bulk, and each later migration that added a table has
-- restated it - so these five were the only rows a non-owner database role could read across
-- business boundaries. The API filters every one of its queries by business_id already; this is
-- the layer underneath that, for the case where something reaches the tables without going
-- through a route.
--
-- Written as its own migration rather than as an edit to 0034 because 0034 is already applied.
-- ---------------------------------------------------------------------------

do $$
declare
  target text;
begin
  foreach target in array array[
    'tax_rates', 'payment_methods', 'card_processors',
    'card_processor_fees', 'card_processor_terminals'
  ] loop
    execute format('alter table %I enable row level security', target);
    execute format(
      'create policy tenant_isolation on %I using (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid) with check (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)',
      target
    );
  end loop;
end $$;

insert into schema_migrations(version) values ('0035_tax_and_payment_settings_rls');
commit;
